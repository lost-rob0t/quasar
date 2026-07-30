import { useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { assertDocument } from "starintel_doc";
import { actorConfigurationStatus } from "../lib/actor-configuration";
import { isBuiltinActor } from "../lib/actors";
import { operation } from "../lib/operations";
import {
  mergeTransformationDocuments,
  recordTransformationRun,
  transformationBatches,
  transformationCandidates
} from "../lib/run-all-transformations";
import { useQuasar } from "../store";

const RUN_ALL_ID = "quasar.run-all-transformations";

function browserActorsSection() {
  return (
    [...document.querySelectorAll(".graph-inspector > section")].find((section) =>
      section.querySelector(":scope > h2")?.textContent?.trim().startsWith("Browser actors")
    ) || null
  );
}

function createHost(section) {
  if (!section) return null;
  const existing = section.querySelector(":scope > .run-all-transformations-host");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "run-all-transformations-host";
  const firstActor = section.querySelector(":scope > .actor-button");
  section.insertBefore(host, firstActor || null);
  return host;
}

function activeGraphDocuments(documents, activeGraph) {
  if (!Array.isArray(activeGraph?.documentIds)) return documents || [];
  const allowed = new Set(activeGraph.documentIds);
  return (documents || []).filter((document) => allowed.has(document._id));
}

function runId() {
  const suffix = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${RUN_ALL_ID}:${suffix}`;
}

function summaryMessage({ actorRuns, actorsTouched, produced, failures, skipped }) {
  const base = `Ran ${actorRuns} transformation batch${
    actorRuns === 1 ? "" : "es"
  } across ${actorsTouched} actor${
    actorsTouched === 1 ? "" : "s"
  }; produced ${produced} document${produced === 1 ? "" : "s"}.`;
  const details = [];
  if (skipped) {
    details.push(
      `${skipped} actor${
        skipped === 1 ? " was" : "s were"
      } already ineligible, manual-only, disabled, or unconfigured`
    );
  }
  if (failures) {
    details.push(`${failures} batch${failures === 1 ? "" : "es"} failed`);
  }
  return details.length ? `${base} ${details.join("; ")}.` : base;
}

export default function RunAllTransformationsBridge() {
  const location = useLocation();
  const { documents, actors, runActor, execute, settings, setNotice, activeGraph } = useQuasar();
  const [host, setHost] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const scopeDocuments = useMemo(
    () => activeGraphDocuments(documents, activeGraph),
    [activeGraph, documents]
  );
  const inputCount = useMemo(
    () => scopeDocuments.filter((document) => document?.dtype !== "relation").length,
    [scopeDocuments]
  );

  useEffect(() => {
    if (location.pathname !== "/graph") {
      setHost(null);
      return undefined;
    }

    const sync = () => setHost(createHost(browserActorsSection()));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => observer.disconnect();
  }, [location.pathname]);

  useEffect(
    () => () => {
      if (host?.isConnected) host.remove();
    },
    [host]
  );

  async function runAllTransformations() {
    if (running || !inputCount) return;
    setRunning(true);
    setResult(null);

    const currentRunId = runId();
    let corpus = (documents || []).map((document) => ({ ...document }));
    const scopeIds = new Set(scopeDocuments.map((document) => document._id));
    const reports = [];
    const outputIds = new Set();

    try {
      for (const actor of actors || []) {
        if (actor.manualOnly) {
          reports.push({
            actorId: actor.id,
            status: "skipped",
            reason: "Manual-only actor."
          });
          continue;
        }
        const customDisabled = !isBuiltinActor(actor) && !settings?.actorsEnabled;
        if (customDisabled) {
          reports.push({
            actorId: actor.id,
            status: "skipped",
            reason: "Custom actor execution is disabled."
          });
          continue;
        }
        const configurationStatus = actorConfigurationStatus(actor);
        if (!configurationStatus.configured) {
          reports.push({
            actorId: actor.id,
            status: "skipped",
            reason: `Missing ${configurationStatus.missing.join(", ")}.`
          });
          continue;
        }

        const actorScope = corpus.filter((document) => scopeIds.has(document._id));
        const candidates = transformationCandidates(actor, actorScope, corpus);
        const batches = transformationBatches(actor, candidates);
        if (!batches.length) {
          reports.push({
            actorId: actor.id,
            status: "skipped",
            reason: "No eligible inputs."
          });
          continue;
        }

        for (const batch of batches) {
          try {
            const actorResult = await runActor(actor, batch, {
              quiet: true,
              runId: currentRunId
            });
            const produced = Array.isArray(actorResult?.documents) ? actorResult.documents : [];
            const removedIds = Array.isArray(actorResult?.removedIds) ? actorResult.removedIds : [];
            corpus = mergeTransformationDocuments(corpus, produced, removedIds);
            removedIds.forEach((id) => scopeIds.delete(id));
            produced.forEach((document) => {
              if (!document?._id) return;
              scopeIds.add(document._id);
              outputIds.add(document._id);
            });

            const corpusById = new Map(corpus.map((document) => [document._id, document]));
            const removed = new Set(removedIds);
            const markedInputs = batch
              .filter((document) => !removed.has(document._id))
              .map((document) => corpusById.get(document._id) || document)
              .map((document) =>
                assertDocument(recordTransformationRun(document, actor.id, currentRunId))
              );
            if (markedInputs.length) {
              await execute(
                operation.batch(
                  markedInputs.map(operation.save),
                  `Record ${actor.label} transformation run`
                ),
                `Record ${actor.label} transformation run`
              );
              corpus = mergeTransformationDocuments(corpus, markedInputs);
            }

            reports.push({
              actorId: actor.id,
              status: "completed",
              inputs: batch.map((document) => document._id),
              produced: produced.length
            });
          } catch (error) {
            reports.push({
              actorId: actor.id,
              status: "failed",
              inputs: batch.map((document) => document._id),
              error: error.message
            });
          }
        }
      }

      const completed = reports.filter((report) => report.status === "completed");
      const failures = reports.filter((report) => report.status === "failed");
      const skipped = reports.filter((report) => report.status === "skipped");
      const actorsTouched = new Set(completed.map((report) => report.actorId)).size;
      const produced = completed.reduce((total, report) => total + report.produced, 0);
      const message = summaryMessage({
        actorRuns: completed.length,
        actorsTouched,
        produced,
        failures: failures.length,
        skipped: skipped.length
      });
      const nextResult = {
        reports,
        produced,
        outputIds: [...outputIds],
        message,
        failures: failures.length
      };
      setResult(nextResult);
      setNotice({
        kind: failures.length ? "error" : "success",
        message
      });
    } catch (error) {
      setNotice({ kind: "error", message: error.message });
      setResult({
        produced: 0,
        outputIds: [],
        failures: 1,
        message: error.message,
        reports
      });
    } finally {
      setRunning(false);
    }
  }

  if (location.pathname !== "/graph" || !host) return null;

  return createPortal(
    <>
      <button
        className="actor-button run-all-transformations-button"
        type="button"
        disabled={running || !inputCount || !(actors || []).length}
        title="Runs every enabled non-manual actor on active-graph inputs that have no links or have not been processed by that actor."
        onClick={runAllTransformations}
      >
        <Play size={14} />
        <span>
          <strong>{running ? "Running all Transformations…" : "Run all Transformations"}</strong>
          <small>
            {inputCount} active-graph input{inputCount === 1 ? "" : "s"} · outputs feed later actors
          </small>
        </span>
      </button>
      {result && (
        <div className="actor-result run-all-transformations-result" role="status">
          <strong>
            {result.produced} document{result.produced === 1 ? "" : "s"} returned
          </strong>
          <span>{result.message}</span>
        </div>
      )}
    </>,
    host
  );
}

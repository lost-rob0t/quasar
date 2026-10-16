import { useEffect, useRef, useState } from "react";
import {
  createActorSubmission,
  readActorDocument,
  submissionStorageKey
} from "../lib/actor-submission";

export default function ServerActorTarget({ actor, configuration }) {
  const [controller, setController] = useState(null);
  const [submission, setSubmission] = useState(null);
  const [subject, setSubject] = useState("");
  const [dataset, setDataset] = useState("default");
  const [documentId, setDocumentId] = useState("");
  const [document, setDocument] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setController(null);
    setSubmission(null);
    setDocument(null);
    setError("");
    setBusy(false);
    submissionStorageKey(configuration, sessionStorage.getItem("quasar-workspace") || "default")
      .then((key) => {
        if (current !== generation.current) return;
        const next = createActorSubmission({
          configuration,
          storage: localStorage,
          key,
          onChange: (state) => {
            if (current === generation.current) setSubmission(state);
          }
        });
        setSubmission(next.getState());
        setController(next);
      })
      .catch((failure) => {
        if (current === generation.current) setError(failure.message);
      });
    return () => {
      generation.current++;
    };
  }, [configuration]);

  async function perform(action) {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      await action(current);
    } catch (failure) {
      if (current === generation.current) setError(failure.message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function openDocument(id) {
    setDocument(null);
    await perform(async (current) => {
      const next = await readActorDocument(configuration, id);
      if (current === generation.current) setDocument(next);
    });
  }

  const canSubmit =
    actor?.resourceKind === "actor" && actor?.alive && actor?.accepts?.targets?.length;
  return (
    <section className="actor-runtime-config" aria-label="Server Target submission">
      <h3>Submit a Target</h3>
      <p>
        Send a one-time Target to this server actor. The browser retains one submission for
        recovery.
      </p>
      {submission ? (
        <>
          <dl className="actor-runtime-details">
            <dt>Actor</dt>
            <dd>{submission.target.actor}</dd>
            <dt>Target</dt>
            <dd>{submission.target.target}</dd>
            <dt>Dataset</dt>
            <dd>{submission.target.dataset}</dd>
            <dt>Submission ID</dt>
            <dd>{submission.target.id}</dd>
            {submission.receipt && (
              <>
                <dt>Server Target ID</dt>
                <dd>{submission.receipt.targetId}</dd>
                <dt>Server request ID</dt>
                <dd>{submission.receipt.requestId}</dd>
              </>
            )}
          </dl>
          <p role="status">
            {submission.receipt
              ? `Server ${submission.receipt.status === "duplicate" ? "confirmed the existing" : "accepted the"} Target. Execution status is unavailable.`
              : "Submission outcome unknown. Retry preserves the same Target and idempotency key."}
          </p>
          <p>
            The server does not expose Target execution progress or correlated result IDs.
            Acceptance is not proof that the actor ran.
          </p>
          <div className="button-row">
            {!submission.receipt && (
              <button
                className="button primary"
                disabled={busy || !controller}
                onClick={() => perform(() => controller.submit())}
              >
                Retry same submission
              </button>
            )}
            {submission.receipt && (
              <button
                className="button"
                disabled={busy}
                onClick={() => openDocument(submission.receipt.targetId)}
              >
                Open server Target
              </button>
            )}
            <button
              className="button"
              disabled={busy || !controller}
              onClick={() => {
                if (
                  !submission.receipt &&
                  !window.confirm(
                    "The server may have accepted this Target. Clearing it loses the retry key and a new submission may duplicate work. Clear anyway?"
                  )
                )
                  return;
                controller.clear();
                setDocument(null);
              }}
            >
              Clear saved submission
            </button>
          </div>
        </>
      ) : (
        <form
          className="page-stack"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => controller.submit(actor, subject, dataset));
          }}
        >
          <label className="field">
            <span>Target input</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              required
              maxLength={4096}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Target dataset</span>
            <input
              value={dataset}
              onChange={(event) => setDataset(event.target.value)}
              required
              maxLength={256}
              disabled={busy}
            />
          </label>
          <button className="button primary" disabled={busy || !controller || !canSubmit}>
            Submit to server
          </button>
          {!canSubmit && <p>This registry entry is not a ready actor accepting Targets.</p>}
        </form>
      )}
      <form
        className="page-stack"
        onSubmit={(event) => {
          event.preventDefault();
          openDocument(documentId.trim());
        }}
      >
        <label className="field">
          <span>Server document ID</span>
          <input
            value={documentId}
            onChange={(event) => setDocumentId(event.target.value)}
            required
            maxLength={512}
          />
        </label>
        <button className="button" disabled={busy || !documentId.trim()}>
          Open server document
        </button>
        <p>
          Reads one document by its exact ID. It does not establish that this Target produced it.
        </p>
      </form>
      {error && (
        <p className="validation-error" role="alert">
          {error}
        </p>
      )}
      {document && (
        <div aria-label="Server document">
          <h4>{document.id}</h4>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(document, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}

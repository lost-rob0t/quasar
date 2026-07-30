import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  GitBranch,
  Link2,
  Network,
  Target,
  TriangleAlert
} from "lucide-react";
import { Link } from "react-router-dom";
import { buildGraph, graphStatistics, partitionDocumentsByReview } from "../lib/graph";
import { useQuasar } from "../store";

function StatCard({ label, value, Icon, detail, tone = "reviewed" }) {
  return (
    <div className={`stat-card stat-card-${tone}`}>
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Distribution({ title, values, tone = "reviewed" }) {
  const entries = Object.entries(values).sort((left, right) => right[1] - left[1]);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  return (
    <section className={`panel distribution distribution-${tone}`}>
      <h2>{title}</h2>
      <div className="distribution-list">
        {entries.map(([label, value]) => (
          <div key={label}>
            <span title={label}>{label}</span>
            <div className="bar">
              <i style={{ width: `${(value / max) * 100}%` }} />
            </div>
            <strong>{value.toLocaleString()}</strong>
          </div>
        ))}
        {!entries.length && <p className="muted">No matching documents.</p>}
      </div>
    </section>
  );
}

function ReviewSummary({ stats }) {
  return (
    <section className="review-summary-card">
      <div className="review-summary-heading">
        <div>
          <span className="eyebrow">Review status</span>
          <h2>Reviewed versus unreviewed</h2>
        </div>
        <strong>{stats.reviewPercent}% reviewed</strong>
      </div>
      <div className="review-meter" aria-label={`${stats.reviewPercent}% reviewed`}>
        <i style={{ width: `${stats.reviewPercent}%` }} />
      </div>
      <div className="review-summary-counts">
        <div>
          <CheckCircle2 size={18} />
          <span>Reviewed</span>
          <strong>{stats.reviewedDocuments.toLocaleString()}</strong>
        </div>
        <div>
          <TriangleAlert size={18} />
          <span>Unreviewed</span>
          <strong>{stats.unreviewedDocuments.toLocaleString()}</strong>
        </div>
      </div>
      <p>
        Primary metrics and the default graph use reviewed records only. Unreviewed records remain
        separate until explicitly enabled.
      </p>
    </section>
  );
}

export default function StatsPage() {
  const { documents, workspace, queryViewCounts } = useQuasar();
  const [viewCounts, setViewCounts] = useState(null);
  const reviewGroups = useMemo(() => partitionDocumentsByReview(documents), [documents]);
  const reviewedGraph = useMemo(
    () => buildGraph(reviewGroups.reviewed, workspace?.positions || {}),
    [reviewGroups.reviewed, workspace?.positions]
  );
  const baseStats = useMemo(
    () => graphStatistics(documents, reviewedGraph),
    [documents, reviewedGraph]
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      queryViewCounts("starintel-core-v1", "review_count"),
      queryViewCounts("starintel-core-v1", "review_dtype_count"),
      queryViewCounts("starintel-core-v1", "review_dataset_count")
    ])
      .then(([review, dtype, dataset]) => {
        if (!active) return;
        setViewCounts({ review, dtype, dataset });
      })
      .catch(() => active && setViewCounts(null));
    return () => {
      active = false;
    };
  }, [documents, queryViewCounts]);

  const stats = useMemo(() => {
    if (!viewCounts) return baseStats;
    const review = Object.fromEntries(viewCounts.review.map(({ key, count }) => [key, count]));
    const byReview = (rows, reviewStatus) =>
      Object.fromEntries(
        rows.filter(({ key }) => key?.[0] === reviewStatus).map(({ key, count }) => [key[1], count])
      );
    const reviewedDocuments = review.reviewed || 0;
    const unreviewedDocuments = review.unreviewed || 0;
    const total = reviewedDocuments + unreviewedDocuments;
    return {
      ...baseStats,
      reviewedDocuments,
      unreviewedDocuments,
      reviewPercent: total ? Math.round((reviewedDocuments / total) * 100) : 0,
      reviewedByDtype: byReview(viewCounts.dtype, "reviewed"),
      unreviewedByDtype: byReview(viewCounts.dtype, "unreviewed"),
      reviewedByDataset: byReview(viewCounts.dataset, "reviewed")
    };
  }, [baseStats, viewCounts]);

  if (!documents.length) {
    return (
      <section className="dashboard-empty-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">Corpus telemetry</span>
            <h1>Statistics dashboard</h1>
            <p>Reviewed and unreviewed StarIntel records are counted separately.</p>
          </div>
        </div>
        <section className="empty-state dashboard-empty">
          <Network size={42} />
          <h2>No documents loaded</h2>
          <p>Import a corpus to populate reviewed metrics and the graph explorer.</p>
          <div className="button-row">
            <Link className="button primary" to="/import">
              Import documents
            </Link>
            <Link className="button" to="/graph">
              Open empty graph
            </Link>
          </div>
        </section>
      </section>
    );
  }

  return (
    <section className="dashboard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Corpus telemetry</span>
          <h1>Statistics dashboard</h1>
          <p>
            Reviewed records drive the primary totals. Unreviewed records are visible as a separate
            queue and never folded into verified metrics.
          </p>
        </div>
      </div>

      <div className="dashboard-hero-grid">
        <Link className="graph-entry-card" to="/graph">
          <div className="graph-entry-icon">
            <Network size={42} />
          </div>
          <div>
            <span className="eyebrow">Full explorer</span>
            <h2>Explore the Graph</h2>
            <p>
              Search the complete relationship network, filter by dataset, document type, predicate,
              and review status, then inspect nodes in context.
            </p>
            <span className="graph-entry-action">
              Open graph explorer <ArrowRight size={18} />
            </span>
          </div>
        </Link>
        <ReviewSummary stats={stats} />
      </div>

      <section className="dashboard-section">
        <div className="section-heading dashboard-section-heading">
          <div>
            <span className="eyebrow">Reviewed corpus</span>
            <h2>Verified statistics</h2>
          </div>
          <span>Unreviewed records excluded</span>
        </div>
        <div className="stats-grid reviewed-stats-grid">
          <StatCard
            label="Reviewed documents"
            value={stats.reviewedDocuments}
            Icon={CheckCircle2}
          />
          <StatCard
            label="Reviewed entities"
            value={stats.reviewedEntities}
            Icon={GitBranch}
            detail="Entity, person, and organization records"
          />
          <StatCard label="Reviewed relations" value={stats.reviewedRelations} Icon={Link2} />
          <StatCard label="Reviewed events" value={stats.reviewedEvents} Icon={FileText} />
          <StatCard
            label="Reviewed targets"
            value={stats.reviewedInvestigationTargets}
            Icon={Target}
          />
        </div>
        <div className="dashboard-grid">
          <Distribution title="Reviewed documents by dtype" values={stats.reviewedByDtype} />
          <Distribution title="Reviewed documents by dataset" values={stats.reviewedByDataset} />
        </div>
      </section>

      <section className="dashboard-section unreviewed-section">
        <div className="section-heading dashboard-section-heading">
          <div>
            <span className="eyebrow unreviewed-eyebrow">Unreviewed queue</span>
            <h2>Records awaiting review</h2>
          </div>
          <span>Not included in reviewed totals</span>
        </div>
        <div className="unreviewed-layout">
          <StatCard
            label="Total unreviewed documents"
            value={stats.unreviewedDocuments}
            Icon={TriangleAlert}
            tone="unreviewed"
            detail="Enable explicitly in the graph review-status filter"
          />
          <Distribution
            title="Unreviewed documents by dtype"
            values={stats.unreviewedByDtype}
            tone="unreviewed"
          />
        </div>
      </section>

      <section className="panel distribution">
        <h2>Most connected reviewed nodes</h2>
        <div className="ranking-list">
          {stats.topConnected.map((item, index) => (
            <div key={item.id}>
              <span>{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                <code>{item.id}</code>
              </div>
              <b>{item.count}</b>
            </div>
          ))}
          {!stats.topConnected.length && <p className="muted">No reviewed connections.</p>}
        </div>
      </section>
    </section>
  );
}

export const VIEW_VERSION = 1;

const map = (source) => `function (doc) {${source}}`;

export const STARINTEL_VIEW_MANIFEST = Object.freeze([
  {
    id: "_design/starintel-core-v1",
    version: VIEW_VERSION,
    views: {
      by_dtype: { map: map("if (doc.dtype) emit(doc.dtype, null);") },
      by_dataset: { map: map("if (doc.dataset) emit(doc.dataset, null);") },
      dtype_count: { map: map("if (doc.dtype) emit(doc.dtype, 1);"), reduce: "_count" },
      dataset_count: { map: map("if (doc.dataset) emit(doc.dataset, 1);"), reduce: "_count" },
      dtype_dataset_count: {
        map: map("if (doc.dtype && doc.dataset) emit([doc.dtype, doc.dataset], 1);"),
        reduce: "_count"
      },
      review_count: {
        map: map(
          "emit(doc.verification && doc.verification.verified === true ? 'reviewed' : 'unreviewed', 1);"
        ),
        reduce: "_count"
      },
      review_dtype_count: {
        map: map(
          "if (doc.dtype) emit([doc.verification && doc.verification.verified === true ? 'reviewed' : 'unreviewed', doc.dtype], 1);"
        ),
        reduce: "_count"
      },
      review_dataset_count: {
        map: map(
          "if (doc.dataset) emit([doc.verification && doc.verification.verified === true ? 'reviewed' : 'unreviewed', doc.dataset], 1);"
        ),
        reduce: "_count"
      }
    }
  },
  {
    id: "_design/starintel-relations-v1",
    version: VIEW_VERSION,
    views: {
      edges: {
        map: map(
          "if (doc.dtype === 'relation' && doc.data && doc.data.subject && doc.data.object) emit(doc.data.subject, {id: doc._id, object: doc.data.object, predicate: doc.data.predicate || 'related-to', directed: doc.data.directed !== false});"
        )
      },
      outgoing: {
        map: map(
          "if (doc.dtype === 'relation' && doc.data && doc.data.subject && doc.data.object) emit(doc.data.subject, doc.data.object);"
        )
      },
      incoming: {
        map: map(
          "if (doc.dtype === 'relation' && doc.data && doc.data.subject && doc.data.object) emit(doc.data.object, doc.data.subject);"
        )
      },
      outgoing_count: {
        map: map(
          "if (doc.dtype === 'relation' && doc.data && doc.data.subject) emit(doc.data.subject, 1);"
        ),
        reduce: "_count"
      },
      incoming_count: {
        map: map(
          "if (doc.dtype === 'relation' && doc.data && doc.data.object) emit(doc.data.object, 1);"
        ),
        reduce: "_count"
      }
    }
  },
  {
    id: "_design/starintel-targets-v1",
    version: VIEW_VERSION,
    views: {
      by_actor: {
        map: map(
          "if (doc.dtype === 'target' && doc.data && doc.data.actor) emit(doc.data.actor, null);"
        )
      },
      actor_count: {
        map: map(
          "if (doc.dtype === 'target' && doc.data && doc.data.actor) emit(doc.data.actor, 1);"
        ),
        reduce: "_count"
      },
      target_count: {
        map: map(
          "if (doc.dtype === 'target' && doc.data && doc.data.target) emit(doc.data.target, 1);"
        ),
        reduce: "_count"
      },
      state_count: {
        map: map("if (doc.dtype === 'target' && doc.data) emit(doc.data.status || 'queued', 1);"),
        reduce: "_count"
      }
    }
  },
  {
    id: "_design/starintel-messages-v1",
    version: VIEW_VERSION,
    views: {
      by_user: {
        map: map(
          "if ((doc.dtype === 'message' || doc.dtype === 'email-message' || doc.dtype === 'social-media-post') && doc.data && doc.data.user) emit([doc.data.user, doc.date_added || doc.date_updated || ''], null);"
        )
      },
      by_channel: {
        map: map(
          "if ((doc.dtype === 'message' || doc.dtype === 'email-message' || doc.dtype === 'social-media-post') && doc.data && doc.data.channel) emit([doc.data.group || null, doc.data.channel, doc.date_added || doc.date_updated || ''], null);"
        )
      },
      by_platform: {
        map: map(
          "if ((doc.dtype === 'message' || doc.dtype === 'social-media-post') && doc.data && doc.data.platform) emit([doc.data.platform, doc.date_added || doc.date_updated || ''], null);"
        )
      }
    }
  },
  {
    id: "_design/starintel-events-v1",
    version: VIEW_VERSION,
    views: {
      by_type: {
        map: map(
          "if (doc.dtype === 'event' && doc.data) emit(doc.data.event_kind || doc.data.type || 'event', null);"
        )
      },
      by_time: {
        map: map(
          "if (doc.dtype === 'event' && doc.data) emit(doc.data.start_at || doc.date_added || doc.date_updated || '', null);"
        )
      }
    }
  }
]);

function designDocument(entry) {
  return {
    _id: entry.id,
    language: "javascript",
    quasar_view_version: entry.version,
    views: entry.views
  };
}

function sameDefinition(current, next) {
  return (
    current?.quasar_view_version === next.quasar_view_version &&
    JSON.stringify(current.views || {}) === JSON.stringify(next.views || {})
  );
}

export async function installStarIntelViews(database) {
  const results = [];
  for (const entry of STARINTEL_VIEW_MANIFEST) {
    const next = designDocument(entry);
    let current = null;
    try {
      current = await database.get(entry.id);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    if (sameDefinition(current, next)) {
      results.push({ id: entry.id, status: "current" });
      continue;
    }
    const result = await database.put({
      ...next,
      ...(current?._rev ? { _rev: current._rev } : {})
    });
    results.push({ id: entry.id, status: current ? "updated" : "installed", rev: result.rev });
  }
  return results;
}

export function queryStarIntelView(database, design, view, options = {}) {
  return database.query(`${design}/${view}`, options);
}

export async function queryCountView(database, design, view, options = {}) {
  const result = await queryStarIntelView(database, design, view, {
    group: true,
    reduce: true,
    ...options
  });
  return result.rows.map((row) => ({ key: row.key, count: row.value }));
}

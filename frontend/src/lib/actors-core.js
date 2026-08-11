const DEFAULT_ACTOR_TIMEOUT_MS = 30_000;
const MAX_ACTOR_TIMEOUT_MS = 120_000;
const MAX_ACTOR_SELECTION = 32;
const MAX_ACTOR_DOCUMENTS = 1_024;

export function generateUsernameCandidatesActor(context) {
  const maxSelection = 8;
  const maxCandidatesPerDocument = 16;
  const selected = Array.isArray(context.selection) ? context.selection.slice(0, maxSelection) : [];
  const documents = [];

  const normalizePart = (value) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const normalizeUsername = (value) =>
    String(value || "")
      .trim()
      .replace(/^@+/, "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "")
      .slice(0, 64);
  const hash = (value) => {
    let state = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const addValue = (target, value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => addValue(target, item));
      return;
    }
    const username = normalizeUsername(value);
    if (username.length >= 2) target.add(username);
  };

  for (const source of selected) {
    const data = source && typeof source.data === "object" ? source.data : {};
    const candidates = new Set();
    addValue(candidates, data.username);
    addValue(candidates, data.user_name);
    addValue(candidates, data.handle);
    addValue(candidates, data.usernames);
    addValue(candidates, data.handles);
    if (source.dtype === "target") {
      const targetType = String(data.target_type || "").toLowerCase();
      const targetValue = String(data.target || "").trim();
      if (
        ["username", "handle", "user"].some((type) => targetType.includes(type)) ||
        targetValue.startsWith("@")
      ) {
        addValue(candidates, targetValue);
      }
    }
    if (Array.isArray(data.external_ids)) {
      data.external_ids
        .filter((identifier) =>
          ["username", "handle"].includes(String(identifier?.scheme || "").toLowerCase())
        )
        .forEach((identifier) => addValue(candidates, identifier.value));
    }

    const explicitFirst = normalizePart(data.first_name || data.given_name || data.fname);
    const explicitMiddle = normalizePart(data.middle_name || data.mname);
    const explicitLast = normalizePart(
      data.last_name || data.family_name || data.surname || data.lname
    );
    const fullName = String(data.full_name || data.name || data.display_name || source.title || "")
      .trim()
      .slice(0, 256);
    const parts = fullName.split(/\s+/).map(normalizePart).filter(Boolean);
    const first = explicitFirst || parts[0] || "";
    const last = explicitLast || (parts.length > 1 ? parts.at(-1) : "");
    const middle =
      explicitMiddle ||
      (parts.length > 2
        ? parts
            .slice(1, -1)
            .map((part) => part[0])
            .join("")
        : "");

    [
      first,
      last,
      first && last ? `${first}${last}` : "",
      first && last ? `${first}.${last}` : "",
      first && last ? `${first}_${last}` : "",
      first && last ? `${first}-${last}` : "",
      first && last ? `${first[0]}${last}` : "",
      first && last ? `${first}${last[0]}` : "",
      first && last ? `${last}${first}` : "",
      first && last ? `${last}.${first}` : "",
      first && last ? `${last}_${first}` : "",
      first && last ? `${last}-${first}` : "",
      first && middle && last ? `${first}${middle}${last}` : "",
      first && middle && last ? `${first}.${middle}.${last}` : "",
      parts.length > 1 ? parts.map((part) => part[0]).join("") : ""
    ].forEach((value) => addValue(candidates, value));

    const stamp = new Date().toISOString();
    for (const username of [...candidates].slice(0, maxCandidatesPerDocument)) {
      const suffix = `${username.replace(/[^a-z0-9]+/g, "-").slice(0, 32)}-${hash(`${source._id}\0${username}`)}`;
      const usernameId = `starintel:entity:username:${suffix}`;
      const actorExtension = {
        actor_id: "quasar.actor.username-candidates",
        input_ids: [source._id],
        generated: true
      };
      documents.push(
        {
          _id: usernameId,
          dataset: source.dataset || "default",
          dtype: "entity",
          schema_version: "0.9.0",
          version: 1,
          date_added: stamp,
          date_updated: stamp,
          title: `@${username}`,
          summary: `Username candidate generated from ${source.title || source._id}`,
          sources: [],
          evidence: [],
          data: {
            name: username,
            etype: "username",
            status: "candidate",
            external_ids: [
              {
                scheme: "username",
                value: username,
                notes: `Candidate generated from ${source._id}`
              }
            ]
          },
          extensions: { "quasar.actor": actorExtension }
        },
        {
          _id: `starintel:relation:username-candidate:${hash(`${source._id}\0${usernameId}`)}`,
          dataset: source.dataset || "default",
          dtype: "relation",
          schema_version: "0.9.0",
          version: 1,
          date_added: stamp,
          date_updated: stamp,
          title: "may-use-username",
          sources: [],
          evidence: [],
          data: {
            subject: source._id,
            predicate: "may-use-username",
            object: usernameId,
            directed: true
          },
          extensions: { "quasar.actor": actorExtension }
        }
      );
    }
  }

  const truncated = Array.isArray(context.selection) && context.selection.length > maxSelection;
  return {
    documents,
    message: `Generated ${documents.length / 2} username candidate(s)${truncated ? ` from the first ${maxSelection} selected documents` : ""}.`
  };
}

export function prepareWhatsMyNameSearchesActor(context) {
  const maxSelection = 16;
  const maxUsernamesPerDocument = 16;
  const selected = Array.isArray(context.selection) ? context.selection.slice(0, maxSelection) : [];
  const documents = [];

  const normalizePart = (value) =>
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const normalizeUsername = (value) =>
    String(value || "")
      .trim()
      .replace(/^@+/, "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "")
      .slice(0, 64);
  const hash = (value) => {
    let state = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const addValue = (target, value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => addValue(target, item));
      return;
    }
    const username = normalizeUsername(value);
    if (username.length >= 2) target.add(username);
  };

  for (const source of selected) {
    const data = source && typeof source.data === "object" ? source.data : {};
    const usernames = new Set();
    addValue(usernames, data.username);
    addValue(usernames, data.user_name);
    addValue(usernames, data.handle);
    addValue(usernames, data.usernames);
    addValue(usernames, data.handles);
    if (source.dtype === "target") {
      const targetType = String(data.target_type || "").toLowerCase();
      const targetValue = String(data.target || "").trim();
      if (
        ["username", "handle", "user"].some((type) => targetType.includes(type)) ||
        targetValue.startsWith("@")
      ) {
        addValue(usernames, targetValue);
      }
    }
    if (Array.isArray(data.external_ids)) {
      data.external_ids
        .filter((identifier) =>
          ["username", "handle"].includes(String(identifier?.scheme || "").toLowerCase())
        )
        .forEach((identifier) => addValue(usernames, identifier.value));
    }

    const name = String(data.full_name || data.name || data.display_name || source.title || "")
      .trim()
      .slice(0, 256);
    const parts = name.split(/\s+/).map(normalizePart).filter(Boolean);
    const first = normalizePart(data.first_name || data.given_name || data.fname) || parts[0] || "";
    const last =
      normalizePart(data.last_name || data.family_name || data.surname || data.lname) ||
      (parts.length > 1 ? parts.at(-1) : "");
    [
      first,
      last,
      first && last ? `${first}${last}` : "",
      first && last ? `${first}.${last}` : "",
      first && last ? `${first}_${last}` : "",
      first && last ? `${first}-${last}` : "",
      first && last ? `${first[0]}${last}` : "",
      first && last ? `${first}${last[0]}` : "",
      first && last ? `${last}${first}` : "",
      first && last ? `${last}.${first}` : ""
    ].forEach((value) => addValue(usernames, value));

    const stamp = new Date().toISOString();
    for (const username of [...usernames].slice(0, maxUsernamesPerDocument)) {
      const queryUrl = `https://whatsmyname.app/?q=${encodeURIComponent(username)}`;
      const queryId = `starintel:entity:whatsmyname:${username.replace(/[^a-z0-9]+/g, "-").slice(0, 32)}-${hash(`${source._id}\0${username}`)}`;
      const actorExtension = {
        actor_id: "quasar.actor.whatsmyname-searches",
        input_ids: [source._id],
        generated: true
      };
      documents.push(
        {
          _id: queryId,
          dataset: source.dataset || "default",
          dtype: "entity",
          schema_version: "0.9.0",
          version: 1,
          date_added: stamp,
          date_updated: stamp,
          title: `WhatsMyName: ${username}`,
          summary: `Prepared WhatsMyName enumeration for @${username}`,
          sources: [],
          evidence: [],
          data: {
            name: `WhatsMyName: ${username}`,
            etype: "osint-query",
            status: "prepared",
            website: queryUrl,
            external_ids: [
              {
                scheme: "username",
                value: username,
                issuer: "WhatsMyName",
                url: queryUrl,
                notes: "Prepared enumeration query"
              }
            ]
          },
          extensions: { "quasar.actor": actorExtension }
        },
        {
          _id: `starintel:relation:whatsmyname-search:${hash(`${source._id}\0${queryId}`)}`,
          dataset: source.dataset || "default",
          dtype: "relation",
          schema_version: "0.9.0",
          version: 1,
          date_added: stamp,
          date_updated: stamp,
          title: "has-username-search",
          sources: [],
          evidence: [],
          data: {
            subject: source._id,
            predicate: "has-username-search",
            object: queryId,
            directed: true
          },
          extensions: { "quasar.actor": actorExtension }
        }
      );
    }
  }

  const truncated = Array.isArray(context.selection) && context.selection.length > maxSelection;
  return {
    documents,
    message: `Prepared ${documents.length / 2} WhatsMyName search(es)${truncated ? ` from the first ${maxSelection} selected documents` : ""}. Open each query document's website field to run the live enumeration.`
  };
}

export function normalizeNamesActor(context) {
  const selection = Array.isArray(context.selection) ? context.selection.slice(0, 32) : [];
  const operations = selection.map((source) => {
    const data = { ...(source.data || {}) };
    const parts = [
      data.fname || data.first_name || data.given_name,
      data.mname || data.middle_name,
      data.lname || data.last_name || data.family_name
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const name = String(data.full_name || data.name || source.title || parts.join(" "))
      .trim()
      .replace(/\s+/g, " ");
    if (source.dtype === "person" && name) data.full_name = name;
    else if (name) data.name = name;
    return {
      op: "update_document",
      document: {
        ...source,
        version: Number(source.version || 0) + 1,
        date_updated: new Date().toISOString(),
        title: name || source.title,
        data,
        extensions: {
          ...(source.extensions || {}),
          "quasar.actor": { actor_id: "quasar.actor.normalize-names", input_ids: [source._id] }
        }
      }
    };
  });
  return { operations, message: `Normalized ${operations.length} name(s).` };
}

export function relationsFromRelatedIdsActor(context) {
  const selection = Array.isArray(context.selection) ? context.selection.slice(0, 32) : [];
  const operations = [];
  const hash = (value) => {
    let state = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const existing = new Set((context.documents || []).map((document) => document._id));
  for (const source of selection) {
    for (const target of (source.related_ids || []).slice(0, 64)) {
      const id = `starintel:relation:related:${hash(`${source._id}\0${target}`)}`;
      if (existing.has(id)) continue;
      const stamp = new Date().toISOString();
      operations.push({
        op: "create_relation",
        document: {
          _id: id,
          dataset: source.dataset || "default",
          dtype: "relation",
          schema_version: "0.9.0",
          version: 1,
          date_added: stamp,
          date_updated: stamp,
          title: "related-to",
          sources: source.sources || [],
          evidence: source.evidence || [],
          data: { subject: source._id, predicate: "related-to", object: target, directed: false },
          extensions: {
            "quasar.actor": {
              actor_id: "quasar.actor.related-id-relations",
              input_ids: [source._id]
            }
          }
        }
      });
      existing.add(id);
    }
  }
  return { operations, message: `Built ${operations.length} relation(s) from related IDs.` };
}

export function markUnverifiedActor(context) {
  const selection = Array.isArray(context.selection) ? context.selection.slice(0, 32) : [];
  return {
    operations: selection.map((source) => ({
      op: "update_document",
      document: {
        ...source,
        version: Number(source.version || 0) + 1,
        date_updated: new Date().toISOString(),
        verification: {
          ...(source.verification || {}),
          verified: false,
          status: "unverified"
        },
        extensions: {
          ...(source.extensions || {}),
          "quasar.actor": { actor_id: "quasar.actor.mark-unverified", input_ids: [source._id] }
        }
      }
    })),
    message: `Marked ${selection.length} document(s) unverified.`
  };
}

export function resolveLegistarClient(input) {
  const data = input?.data && typeof input.data === "object" ? input.data : input || {};
  const candidates = [
    data.legistar_client,
    data.legistarClient,
    data.client,
    data.city,
    data.municipality,
    data.target,
    data.name,
    input?.title
  ];

  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw || raw.includes("@")) continue;
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (host === "webapi.legistar.com") {
        const match = url.pathname.match(/\/v1\/([^/]+)/i);
        if (match?.[1]) return decodeURIComponent(match[1]).toLowerCase();
      }
      if (host.endsWith(".legistar.com")) {
        const client = host.slice(0, -".legistar.com".length);
        if (client && client !== "www" && client !== "webapi") return client;
      }
      continue;
    } catch {
      // Plain city and client names are handled below.
    }

    const clean = raw
      .replace(/^city\s*:\s*/i, "")
      .replace(/,.*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 64);
    if (clean.length >= 2) return clean;
  }
  return "";
}

export function targetInputExpansionActor(context) {
  const selection = Array.isArray(context.selection) ? context.selection.slice(0, 16) : [];
  const corpus = new Map((context.documents || []).map((document) => [document._id, document]));
  const existing = new Set(corpus.keys());
  const documents = [];

  const hash = (value) => {
    let state = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const addInput = (values, value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => addInput(values, item));
      return;
    }
    if (value && typeof value === "object") {
      addInput(values, value.target);
      addInput(values, value.value);
      addInput(values, value.url);
      addInput(values, value.domain);
      addInput(values, value.email);
      addInput(values, value.username);
      return;
    }
    const clean = String(value || "").trim();
    if (clean) values.add(clean.slice(0, 2048));
  };
  const classify = (raw) => {
    if (/^starintel:[^\s]+$/i.test(raw)) return { kind: "document-reference", value: raw };
    try {
      const url = new URL(raw);
      if (["http:", "https:"].includes(url.protocol)) {
        return { kind: "url", value: url.href, website: url.href };
      }
    } catch {
      // Non-URL input continues through typed classifiers.
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      return { kind: "email", value: raw.toLowerCase() };
    }
    if (/^@[a-z0-9._-]{2,64}$/i.test(raw)) {
      return { kind: "username", value: raw.replace(/^@/, "").toLowerCase() };
    }
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(raw)) {
      const value = raw.toLowerCase();
      return { kind: "domain", value, website: `https://${value}` };
    }
    return { kind: "search-term", value: raw };
  };

  for (const source of selection) {
    if (source?.dtype !== "target") continue;
    const data = source.data && typeof source.data === "object" ? source.data : {};
    const inputs = new Set();
    addInput(inputs, data.target);
    addInput(inputs, data.targets);
    addInput(inputs, data.value);
    addInput(inputs, data.input);
    addInput(inputs, data.query);
    addInput(inputs, data.url);
    addInput(inputs, data.domain);
    addInput(inputs, data.email);
    addInput(inputs, data.username);
    addInput(inputs, data.options);

    for (const raw of [...inputs].slice(0, 64)) {
      const classified = classify(raw);
      let objectId = classified.value;
      if (classified.kind !== "document-reference" || !corpus.has(classified.value)) {
        const slug =
          classified.value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 42) || classified.kind;
        objectId = `starintel:entity:target-input:${slug}-${hash(`${source._id}\0${classified.kind}\0${classified.value}`)}`;
        if (!existing.has(objectId)) {
          const stamp = new Date().toISOString();
          const actorExtension = {
            actor_id: "quasar.actor.target-input-expansion",
            input_ids: [source._id],
            generated: true
          };
          const externalId = {
            scheme: classified.kind,
            value: classified.value,
            notes: `Expanded from target ${source._id}`
          };
          if (classified.website) externalId.url = classified.website;
          documents.push({
            _id: objectId,
            dataset: source.dataset || "default",
            dtype: "entity",
            schema_version: "0.9.0",
            version: 1,
            date_added: stamp,
            date_updated: stamp,
            title: classified.kind === "username" ? `@${classified.value}` : classified.value,
            summary: `${classified.kind} expanded from ${source.title || source._id}`,
            sources: source.sources || [],
            evidence: source.evidence || [],
            data: {
              name: classified.value,
              etype: classified.kind,
              status: "target-input",
              ...(classified.website ? { website: classified.website } : {}),
              external_ids: [externalId]
            },
            extensions: { "quasar.actor": actorExtension }
          });
          existing.add(objectId);
        }
      }

      const relationId = `starintel:relation:target-input:${hash(`${source._id}\0${objectId}`)}`;
      if (existing.has(relationId)) continue;
      const stamp = new Date().toISOString();
      documents.push({
        _id: relationId,
        dataset: source.dataset || "default",
        dtype: "relation",
        schema_version: "0.9.0",
        version: 1,
        date_added: stamp,
        date_updated: stamp,
        title: "targets",
        sources: source.sources || [],
        evidence: source.evidence || [],
        data: {
          subject: source._id,
          predicate: "targets",
          object: objectId,
          directed: true
        },
        extensions: {
          "quasar.actor": {
            actor_id: "quasar.actor.target-input-expansion",
            input_ids: [source._id],
            generated: true
          }
        }
      });
      existing.add(relationId);
    }
  }

  return {
    documents,
    message: `Expanded ${documents.filter((document) => document.dtype !== "relation").length} target input(s).`
  };
}

export async function cityLegistarCalendarActor(context, api) {
  const source = Array.isArray(context.selection) ? context.selection[0] : null;
  if (!source)
    return { documents: [], message: "Select a city, location, organization, entity, or target." };

  const resolveClient = (input) => {
    const data = input?.data && typeof input.data === "object" ? input.data : input || {};
    const candidates = [
      data.legistar_client,
      data.legistarClient,
      data.client,
      data.city,
      data.municipality,
      data.target,
      data.name,
      input?.title
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || "").trim();
      if (!raw || raw.includes("@")) continue;
      try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        if (host === "webapi.legistar.com") {
          const match = url.pathname.match(/\/v1\/([^/]+)/i);
          if (match?.[1]) return decodeURIComponent(match[1]).toLowerCase();
        }
        if (host.endsWith(".legistar.com")) {
          const client = host.slice(0, -".legistar.com".length);
          if (client && client !== "www" && client !== "webapi") return client;
        }
        continue;
      } catch {
        // Plain city and client names are handled below.
      }
      const clean = raw
        .replace(/^city\s*:\s*/i, "")
        .replace(/,.*$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 64);
      if (clean.length >= 2) return clean;
    }
    return "";
  };
  const hash = (value) => {
    let state = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      state ^= value.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const absolute = (value, site) => {
    if (!value) return "";
    try {
      return new URL(value, site).href;
    } catch {
      return "";
    }
  };

  const client = resolveClient(source);
  if (!client) return { documents: [], message: "No Legistar city/client input was found." };
  const data = source.data && typeof source.data === "object" ? source.data : {};
  const DAY = 86_400_000;
  const now = Date.now();
  const from = new Date(data.from || now - 30 * DAY);
  const to = new Date(data.to || now + 180 * DAY);
  const limit = Math.max(1, Math.min(Number(data.limit) || 100, 200));
  const apiBase = `https://webapi.legistar.com/v1/${encodeURIComponent(client)}`;
  const site = `https://${client}.legistar.com`;
  const response = await api.network.fetch({
    url: `${apiBase}/events?$top=${limit}`,
    responseType: "json",
    options: { headers: { accept: "application/json" } }
  });
  if (!response.ok) throw new Error(`Legistar ${client} returned HTTP ${response.status}`);
  const payload = response.body;
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.value)
      ? payload.value
      : [];
  const existing = new Set((context.documents || []).map((document) => document._id));
  const documents = [];

  for (const event of events.slice(0, limit)) {
    const rawDate = event.EventDate || event.EventDateTime || event.EventLastModifiedUtc;
    const eventDate = rawDate ? new Date(rawDate) : null;
    if (eventDate && Number.isFinite(eventDate.getTime())) {
      if (eventDate < from || eventDate > to) continue;
    }
    const eventIdValue = String(event.EventId || hash(JSON.stringify(event))).slice(0, 80);
    const eventId = `starintel:event:legistar-${client}-${eventIdValue}`;
    const relationId = `starintel:relation:legistar-calendar:${hash(`${source._id}\0${eventId}`)}`;
    const stamp = new Date().toISOString();
    const name =
      [
        event.EventBodyName,
        event.EventDate ? new Date(event.EventDate).toLocaleDateString("en-US") : ""
      ]
        .filter(Boolean)
        .join(" · ") || `Legistar event ${eventIdValue}`;
    const website = absolute(
      event.EventInSiteURL || event.EventAgendaFile || event.EventMinutesFile,
      site
    );
    const actorExtension = {
      actor_id: "quasar.actor.city-legistar-calendar",
      input_ids: [source._id],
      generated: true,
      client
    };

    if (!existing.has(eventId)) {
      documents.push({
        _id: eventId,
        dataset: source.dataset || `legistar-${client}`,
        dtype: "event",
        schema_version: "0.9.0",
        version: 1,
        date_added: stamp,
        date_updated: stamp,
        title: name,
        summary: `Public meeting from the ${client} Legistar calendar`,
        sources: [],
        evidence: [],
        data: {
          name,
          event_type: "government-meeting",
          start_time:
            eventDate && Number.isFinite(eventDate.getTime()) ? eventDate.toISOString() : "",
          location: event.EventLocation || "",
          status: event.EventAgendaStatusName || String(event.EventAgendaStatusId || ""),
          website,
          legistar_client: client,
          legistar_event_id: event.EventId,
          body: event.EventBodyName || ""
        },
        extensions: { "quasar.actor": actorExtension }
      });
      existing.add(eventId);
    }
    if (!existing.has(relationId)) {
      documents.push({
        _id: relationId,
        dataset: source.dataset || `legistar-${client}`,
        dtype: "relation",
        schema_version: "0.9.0",
        version: 1,
        date_added: stamp,
        date_updated: stamp,
        title: "has-calendar-event",
        sources: [],
        evidence: [],
        data: {
          subject: source._id,
          predicate: "has-calendar-event",
          object: eventId,
          directed: true
        },
        extensions: { "quasar.actor": actorExtension }
      });
      existing.add(relationId);
    }
  }

  return {
    documents,
    message: `Loaded ${documents.filter((document) => document.dtype === "event").length} ${client} Legistar event(s).`
  };
}

export function actorsForTarget(actors, target, trigger = "target:create") {
  const data = target?.data && typeof target.data === "object" ? target.data : {};
  const requested = new Set();
  const add = (value) => {
    if (Array.isArray(value)) value.forEach(add);
    else
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => requested.add(item));
  };
  add(data.actor);
  add(data.actors);

  return (actors || []).filter((actor) => {
    const normalized = normalizeActorManifest(actor);
    return normalized.triggers.includes(trigger) || requested.has(normalized.id);
  });
}

export const BUILTIN_ACTORS = Object.freeze([
  {
    id: "quasar.actor.derive-node",
    label: "Create derived node",
    description: "Create one derived entity and relation from the first selected document.",
    version: 1,
    accepts: ["*"],
    minSelection: 1,
    maxSelection: 1,
    source: `(context) => {
      const source = context.selection[0];
      if (!source) return { documents: [], message: "Select one document." };
      const stamp = new Date().toISOString();
      const id = source._id + ":derived:" + Date.now().toString(36);
      return {
        message: "Created one derived node and relation.",
        documents: [
          {
            _id: id,
            dataset: source.dataset,
            dtype: "entity",
            schema_version: "0.9.0",
            version: 1,
            date_added: stamp,
            date_updated: stamp,
            title: "Derived from " + (source.title || source._id),
            sources: [],
            evidence: [],
            data: { name: "Derived from " + (source.title || source._id), etype: "derived" },
            extensions: { "quasar.actor": { actor_id: "quasar.actor.derive-node", input_ids: [source._id] } }
          },
          {
            _id: "starintel:relation:" + Date.now().toString(36) + "-derived",
            dataset: source.dataset,
            dtype: "relation",
            schema_version: "0.9.0",
            version: 1,
            date_added: stamp,
            date_updated: stamp,
            title: "derived-from",
            sources: [],
            evidence: [],
            data: { subject: id, predicate: "derived-from", object: source._id, directed: true },
            extensions: { "quasar.actor": { actor_id: "quasar.actor.derive-node", input_ids: [source._id] } }
          }
        ]
      };
    }`
  },
  {
    id: "quasar.actor.username-candidates",
    label: "Generate username candidates",
    description: "Generate bounded username variants from selected names and existing handles.",
    version: 1,
    accepts: ["person", "entity", "user", "org", "target"],
    minSelection: 1,
    maxSelection: 8,
    source: generateUsernameCandidatesActor.toString()
  },
  {
    id: "quasar.actor.whatsmyname-searches",
    label: "Prepare WhatsMyName searches",
    description: "Create WhatsMyName query documents from selected usernames or person names.",
    version: 1,
    accepts: ["person", "entity", "user", "org", "target"],
    minSelection: 1,
    maxSelection: 16,
    source: prepareWhatsMyNameSearchesActor.toString()
  },
  {
    id: "quasar.actor.target-input-expansion",
    label: "Expand target inputs",
    description: "Turn target values into typed graph entities and explicit target relations.",
    version: 1,
    accepts: ["target"],
    triggers: ["target:create"],
    minSelection: 1,
    maxSelection: 16,
    source: targetInputExpansionActor.toString()
  },
  {
    id: "quasar.actor.city-legistar-calendar",
    label: "Load city Legistar calendar",
    description:
      "Load bounded public meeting records for a city or Legistar client supplied by the selected input.",
    version: 1,
    accepts: ["target", "location", "org", "entity"],
    triggers: [],
    capabilities: ["network.fetch"],
    minSelection: 1,
    maxSelection: 1,
    source: cityLegistarCalendarActor.toString()
  },
  {
    id: "quasar.actor.normalize-names",
    label: "Normalize names",
    description: "Normalize selected person and entity names without replacing provenance.",
    version: 1,
    accepts: ["person", "org", "entity"],
    minSelection: 1,
    maxSelection: 32,
    source: normalizeNamesActor.toString()
  },
  {
    id: "quasar.actor.related-id-relations",
    label: "Build related-ID relations",
    description: "Convert related IDs into explicit related-to relation documents.",
    version: 1,
    accepts: ["*"],
    minSelection: 1,
    maxSelection: 32,
    source: relationsFromRelatedIdsActor.toString()
  },
  {
    id: "quasar.actor.mark-unverified",
    label: "Mark unverified",
    description: "Mark selected documents unverified for review.",
    version: 1,
    accepts: ["*"],
    minSelection: 1,
    maxSelection: 32,
    source: markUnverifiedActor.toString()
  }
]);

export function normalizeActorManifest(manifest) {
  if (!manifest || typeof manifest !== "object")
    throw new TypeError("Actor manifest must be an object");
  const minSelection = manifest.minSelection === undefined ? 1 : Number(manifest.minSelection);
  const maxSelection =
    manifest.maxSelection === undefined ? MAX_ACTOR_SELECTION : Number(manifest.maxSelection);
  const actor = {
    id: String(manifest.id || "").trim(),
    label: String(manifest.label || manifest.id || "").trim(),
    description: String(manifest.description || "").trim(),
    version: Number(manifest.version || 1),
    accepts: Array.isArray(manifest.accepts) ? [...new Set(manifest.accepts.map(String))] : ["*"],
    triggers: Array.isArray(manifest.triggers)
      ? [
          ...new Set(
            manifest.triggers.map((trigger) => String(trigger || "").trim()).filter(Boolean)
          )
        ]
      : [],
    runtime: String(manifest.runtime || BROWSER_ACTOR_RUNTIME).trim(),
    capabilities: Array.isArray(manifest.capabilities)
      ? [
          ...new Set(
            manifest.capabilities
              .map((capability) => String(capability || "").trim())
              .filter(Boolean)
          )
        ]
      : [],
    limits:
      manifest.limits && typeof manifest.limits === "object" && !Array.isArray(manifest.limits)
        ? { ...manifest.limits }
        : {},
    minSelection,
    maxSelection,
    source: String(manifest.source || "").trim()
  };
  if (!actor.id) throw new TypeError("Actor id is required");
  if (!actor.label) throw new TypeError("Actor label is required");
  if (!Number.isInteger(actor.version) || actor.version < 1)
    throw new TypeError("Actor version must be a positive integer");
  if (!actor.accepts.length) throw new TypeError("Actor accepts must contain at least one dtype");
  if (
    !Number.isInteger(actor.minSelection) ||
    actor.minSelection < 0 ||
    actor.minSelection > MAX_ACTOR_SELECTION
  ) {
    throw new TypeError(`Actor minSelection must be an integer from 0 to ${MAX_ACTOR_SELECTION}`);
  }
  if (
    !Number.isInteger(actor.maxSelection) ||
    actor.maxSelection < actor.minSelection ||
    actor.maxSelection > MAX_ACTOR_SELECTION
  ) {
    throw new TypeError(
      `Actor maxSelection must be an integer from minSelection to ${MAX_ACTOR_SELECTION}`
    );
  }
  if (!actor.source) throw new TypeError("Actor source is required");
  return actor;
}

export function actorApplicability(manifest, selection) {
  const actor = normalizeActorManifest(manifest);
  const selected = Array.isArray(selection) ? selection : [];
  if (selected.length < actor.minSelection) {
    return {
      applicable: false,
      reason:
        actor.minSelection === 1
          ? "Select a graph document."
          : `Select at least ${actor.minSelection} graph documents.`
    };
  }
  if (selected.length > actor.maxSelection) {
    return {
      applicable: false,
      reason: `Select no more than ${actor.maxSelection} graph documents.`
    };
  }
  const accepted = new Set(actor.accepts);
  if (!accepted.has("*")) {
    const rejected = selected.find((document) => !accepted.has(document.dtype));
    if (rejected)
      return { applicable: false, reason: `Does not accept ${rejected.dtype} documents.` };
  }
  return { applicable: true, reason: "" };
}

export function actorApplicable(actor, selection) {
  return actorApplicability(actor, selection).applicable;
}

export function isBuiltinActor(actor) {
  return BUILTIN_ACTORS.some(
    (candidate) => candidate.id === actor?.id && candidate.source === actor?.source
  );
}

const ACTOR_RESPONSE_LIMIT = 1_048_576;
const FORBIDDEN_ACTOR_HEADER =
  /^(?:authorization|cookie|proxy-|sec-|host$|origin$|referer$|x-api-key$)/i;

function assertLiteralPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new Error("Actor network.fetch blocks private network URLs");
}

async function readBoundedActorBody(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ACTOR_RESPONSE_LIMIT) {
      await reader.cancel("Actor response limit exceeded");
      throw new RangeError(`Actor response exceeds ${ACTOR_RESPONSE_LIMIT} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function networkFetchService(payload, { signal }) {
  const url = new URL(String(payload?.url || payload || ""));
  if (url.protocol !== "https:") throw new Error("Actor network.fetch requires HTTPS");
  assertLiteralPublicHost(url);
  const options = payload?.options && typeof payload.options === "object" ? payload.options : {};
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) throw new Error(`Actor network.fetch rejects ${method}`);
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([name, value]) => {
      if (FORBIDDEN_ACTOR_HEADER.test(name))
        throw new Error(`Actor request header denied: ${name}`);
      return [name, String(value)];
    })
  );
  const response = await fetch(url.href, {
    method,
    headers,
    credentials: "omit",
    redirect: "error",
    signal
  });
  const bytes = await readBoundedActorBody(response, signal);
  const raw = new TextDecoder().decode(bytes);
  const responseType = payload?.responseType === "json" ? "json" : "text";
  const body = responseType === "json" && raw ? JSON.parse(raw) : raw;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    body
  };
}

function documentGetService(payload, { context }) {
  return (context.documents || []).find((document) => document._id === payload?.id) || null;
}

function documentQueryService(payload = {}, { context }) {
  const ids = new Set(Array.isArray(payload.ids) ? payload.ids : []);
  const limit = Math.max(1, Math.min(Number(payload.limit) || 100, 1_000));
  return (context.documents || [])
    .filter((document) => !ids.size || ids.has(document._id))
    .filter((document) => !payload.dataset || document.dataset === payload.dataset)
    .filter((document) => !payload.dtype || document.dtype === payload.dtype)
    .slice(0, limit);
}

function browserOpenService(payload) {
  const url = new URL(String(payload?.url || ""));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Actor browser.open rejects ${url.protocol || "unknown"} URLs`);
  }
  const opened = globalThis.open?.(url.href, "_blank", "noopener,noreferrer");
  return { opened: Boolean(opened), url: url.href };
}

function eventEmitService(payload) {
  const name = String(payload?.name || payload?.type || "").trim();
  if (!name) throw new Error("Actor event name is required");
  globalThis.dispatchEvent?.(new CustomEvent(`quasar:actor:${name}`, { detail: payload?.data }));
  return { emitted: true, name };
}

export async function runBrowserActor(
  manifest,
  context,
  { timeout = DEFAULT_ACTOR_TIMEOUT_MS, signal, onEvent, trusted = false } = {}
) {
  if (!trusted) {
    throw new Error(
      "Custom browser actor execution is disabled until the opaque-origin sandbox is available"
    );
  }
  const actor = normalizeActorManifest(manifest);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_ACTOR_TIMEOUT_MS) {
    throw new TypeError(`Actor timeout must be an integer from 1 to ${MAX_ACTOR_TIMEOUT_MS}`);
  }
  const runtime = createBrowserActorRuntime({
    services: {
      "documents.get": documentGetService,
      "documents.query": documentQueryService,
      "network.fetch": networkFetchService,
      "browser.open": browserOpenService,
      "events.emit": eventEmitService
    }
  });
  let requests = 0;
  const result = await runtime.run(
    browserActorManifestFromLegacy({
      ...actor,
      timeoutMs: timeout,
      limits: {
        ...actor.limits,
        timeoutMs: timeout,
        maxDocuments: Math.min(
          actor.limits.maxDocuments || MAX_ACTOR_DOCUMENTS,
          MAX_ACTOR_DOCUMENTS
        )
      }
    }),
    context,
    {
      timeoutMs: timeout,
      signal,
      onEvent: (event) => {
        if (event.event === "capability-request") requests += 1;
        onEvent?.(event);
      }
    }
  );
  return {
    ...result,
    metrics: {
      ...result.metrics,
      requests: result.metrics.requests ?? requests
    }
  };
}
import {
  BROWSER_ACTOR_RUNTIME,
  browserActorManifestFromLegacy,
  createBrowserActorRuntime
} from "./browser-actor-runtime";

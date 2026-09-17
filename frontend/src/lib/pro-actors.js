export const PRO_ACTOR_REPOSITORY = "lost-rob0t/starintel-pro-actors";
export const PRO_ACTOR_MANIFEST_EXTENSION = "starintel.actor_manifest.v1";
export const PRO_ACTOR_SUBMIT_CAPABILITY = "pro-actors.submit-target";
export const PRO_ACTOR_MANIFEST_CAPABILITY = "pro-actors.manifests";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

export function actorManifestContract(document) {
  if (document?.dtype !== "actor-manifest") return null;
  const contract = object(document.extensions?.[PRO_ACTOR_MANIFEST_EXTENSION]);
  if (!nonEmpty(contract.actor_id)) return null;
  return contract;
}

export function normalizeProActorManifest(document) {
  const contract = actorManifestContract(document);
  if (!contract) return null;
  if (nonEmpty(contract.implementation?.repository) !== PRO_ACTOR_REPOSITORY) return null;
  const actorId = nonEmpty(contract.actor_id || document.data?.actor);
  if (!actorId) return null;
  return {
    id: actorId,
    label: actorId
      .split("-")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
      .join(" "),
    actorType: nonEmpty(contract.actor_type),
    runtime: nonEmpty(contract.runtime),
    operations: Array.isArray(contract.operations) ? contract.operations.map(String) : [],
    inputDtypes: Array.isArray(contract.input_dtypes) ? contract.input_dtypes.map(String) : [],
    outputDtypes: Array.isArray(contract.output_dtypes) ? contract.output_dtypes.map(String) : [],
    capabilities: Array.isArray(contract.capabilities) ? contract.capabilities.map(String) : [],
    targetOptions: Array.isArray(document.data?.target_options)
      ? document.data.target_options.filter((option) => option && typeof option === "object")
      : [],
    configurationSchema: object(contract.configuration_schema),
    authorization: object(contract.authorization),
    document
  };
}

export function listProActorManifests(documents) {
  const byId = new Map();
  for (const document of documents || []) {
    const manifest = normalizeProActorManifest(document);
    if (manifest) byId.set(manifest.id, manifest);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function defaultConfigForManifest(manifest) {
  const properties = object(manifest?.configurationSchema?.properties);
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, schema]) => object(schema).writeOnly !== true)
      .filter(([, schema]) => Object.hasOwn(object(schema), "default"))
      .map(([key, schema]) => [key, structuredClone(object(schema).default)])
  );
}

export function editableConfigProperties(manifest) {
  const properties = object(manifest?.configurationSchema?.properties);
  return Object.entries(properties)
    .filter(([, schema]) => object(schema).writeOnly !== true)
    .map(([name, schema]) => ({ name, ...object(schema) }));
}

export function editableTargetOptions(manifest) {
  return (manifest?.targetOptions || []).filter(
    (option) => nonEmpty(option.key) && option.key !== "config" && option.writeOnly !== true
  );
}

export function parseManifestValue(raw, schema = {}) {
  if (schema.type === "boolean") return Boolean(raw === true || raw === "true");
  if (schema.type === "integer") {
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${schema.title || "Value"} must be an integer`);
    return value;
  }
  if (schema.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${schema.title || "Value"} must be a number`);
    return value;
  }
  if (schema.type === "array" || schema.type === "object") {
    if (typeof raw !== "string") return raw;
    const text = raw.trim();
    if (!text) return schema.type === "array" ? [] : {};
    const value = JSON.parse(text);
    if (schema.type === "array" && !Array.isArray(value)) throw new Error("Value must be an array");
    if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
      throw new Error("Value must be an object");
    }
    return value;
  }
  return String(raw ?? "");
}

function first(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text) return text;
  }
  return "";
}

function personName(document) {
  const data = object(document?.data);
  return first(
    data.full_name,
    data.name,
    [data.fname, data.mname, data.lname].map(nonEmpty).filter(Boolean).join(" "),
    document?.title,
    document?._id
  );
}

function addressValue(document) {
  const data = object(document?.data);
  const parts = [
    data.address,
    data.address1,
    data.street,
    data.city,
    data.state,
    data.postal_code || data.zip,
    data.country
  ]
    .map(nonEmpty)
    .filter(Boolean);
  return first(parts.join(", "), data.name, document?.title, document?._id);
}

function coordinates(document) {
  const data = object(document?.data);
  const latitude = data.latitude ?? data.lat;
  const longitude = data.longitude ?? data.lon ?? data.lng;
  if (latitude === undefined || longitude === undefined) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon, target: `${lat},${lon}` };
}

function melissaFields(document) {
  const data = object(document?.data);
  const fields = {};
  const candidates = {
    email: data.email,
    phone: data.phone || data.telephone || data.mobile,
    address: data.address || data.address1 || data.street,
    city: data.city,
    state: data.state,
    postal_code: data.postal_code || data.zip,
    country: data.country,
    company: data.company || (document?.dtype === "org" ? data.name : undefined),
    first_name: data.fname || data.first_name || data.given_name,
    middle_name: data.mname || data.middle_name,
    last_name: data.lname || data.last_name || data.family_name
  };
  for (const [key, value] of Object.entries(candidates)) {
    const normalized = nonEmpty(value);
    if (normalized) fields[key] = normalized;
  }
  return fields;
}

export function melissaTargetFromDocument(document) {
  if (!document || typeof document !== "object") throw new Error("Select a document for Melissa");
  const data = object(document.data);
  if (document.dtype === "target" && nonEmpty(data.target)) {
    return {
      target: nonEmpty(data.target),
      targetType: nonEmpty(data.target_type) || "person",
      fields: object(data.fields)
    };
  }

  const dtype = nonEmpty(document.dtype).toLowerCase();
  const etype = nonEmpty(data.etype).toLowerCase();
  const geo = coordinates(document);
  if (geo && ["location", "geo", "geolocation"].includes(dtype)) {
    return { target: geo.target, targetType: "geo", fields: {} };
  }

  if (dtype === "person" || etype === "person") {
    return { target: personName(document), targetType: "person", fields: melissaFields(document) };
  }
  if (dtype === "org" || ["org", "organization", "company"].includes(etype)) {
    return {
      target: first(data.name, data.legal_name, document.title, document._id),
      targetType: "org",
      fields: melissaFields(document)
    };
  }
  if (dtype === "phone" || ["phone", "telephone", "mobile"].includes(etype)) {
    return { target: first(data.phone, data.value, data.name, document.title), targetType: "phone", fields: {} };
  }
  if (dtype === "email" || etype === "email") {
    return { target: first(data.email, data.value, data.name, document.title), targetType: "email", fields: {} };
  }
  if (dtype === "address" || etype === "address") {
    return { target: addressValue(document), targetType: "address", fields: melissaFields(document) };
  }
  if (dtype === "location") {
    return geo
      ? { target: geo.target, targetType: "geo", fields: {} }
      : { target: addressValue(document), targetType: "address", fields: melissaFields(document) };
  }
  if (dtype === "ip" || ["ip", "ip-address"].includes(etype)) {
    return { target: first(data.ip, data.value, data.name, document.title), targetType: "ip", fields: {} };
  }

  const fallbackPhone = first(data.phone, data.telephone, data.mobile);
  if (fallbackPhone) return { target: fallbackPhone, targetType: "phone", fields: melissaFields(document) };
  const fallbackEmail = first(data.email);
  if (fallbackEmail) return { target: fallbackEmail, targetType: "email", fields: melissaFields(document) };
  if (geo) return { target: geo.target, targetType: "geo", fields: {} };
  throw new Error(`Melissa does not know how to derive a target from ${document.dtype || "this document"}`);
}

export function actorTargetFromDocument(manifest, document) {
  if (!manifest) throw new Error("Choose a pro actor");
  if (!document) throw new Error("Select a graph document first");
  if (manifest.id === "melissa") return melissaTargetFromDocument(document);
  const data = object(document.data);
  return {
    target: first(data.target, data.url, data.uri, data.name, document.title, document._id),
    targetType: first(data.target_type, document.dtype, "entity"),
    fields: {}
  };
}

export function targetOptionsForRun(config = {}, operationOptions = {}, derivedFields = {}) {
  const options = [];
  if (config && Object.keys(config).length) options.push({ key: "config", value: config });
  const fields = { ...derivedFields, ...object(operationOptions.fields) };
  if (Object.keys(fields).length) options.push({ key: "fields", value: fields });
  for (const [key, value] of Object.entries(operationOptions || {})) {
    if (key === "fields" || value === undefined || value === "") continue;
    options.push({ key, value });
  }
  return options;
}

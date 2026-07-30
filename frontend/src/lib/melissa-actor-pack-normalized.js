import { MELISSA_ACTORS as BASE_MELISSA_ACTORS } from "./melissa-actor-pack";

export const MELISSA_ACTOR_PACK_VERSION = 4;

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Unable to patch Melissa actor source: ${label}`);
  }
  return source.replace(before, after);
}

function normalizeActorSource(actor) {
  let source = actor.source;

  source = replaceRequired(
    source,
    `    const firstInput = (source, names) => findValue(source?.data || {}, names) || findValue(source || {}, names);`,
    `    const firstInput = (source, names) => findValue(source?.data || {}, names) || findValue(source || {}, names);
    const externalIdValue = (source, schemes) => {
      const identifiers = source?.data?.external_ids || source?.external_ids || [];
      if (!Array.isArray(identifiers)) return "";
      const wanted = new Set(schemes.map(cleanKey));
      for (const identifier of identifiers) {
        if (!identifier || typeof identifier !== "object") continue;
        const scheme = cleanKey(identifier.scheme || identifier.type || identifier.name);
        if (!wanted.has(scheme)) continue;
        const value = scalar(identifier.value || identifier.id || identifier.key);
        if (value) return value;
      }
      return "";
    };`,
    "external identifier extraction"
  );

  source = replaceRequired(
    source,
    `      const address1 = ["email", "phone", "ip"].includes(source?.dtype)
        ? firstInput(source, ["address_line_1", "address1", "a1", "street"])
        : firstInput(source, ["address_line_1", "address1", "a1", "street", "address"]);`,
    `      const address1 = (["email", "phone", "ip"].includes(source?.dtype)
        ? firstInput(source, ["address_line_1", "address1", "a1", "street"])
        : firstInput(source, ["address_line_1", "address1", "a1", "street", "address"]))
        || (["location", "address", "asset"].includes(source?.dtype)
          ? text(data.address || data.street || data.value || data.main || source?.title)
          : "");`,
    "address fallback"
  );

  source = replaceRequired(
    source,
    `      const email = source?.dtype === "email"
        ? text(data.address || data.value)
        : firstInput(source, ["email", "email_address"]);`,
    `      const email = source?.dtype === "email"
        ? text(data.email || data.address || data.value || data.main || source?.title)
        : firstInput(source, ["email", "email_address"]);`,
    "email fallback"
  );

  source = replaceRequired(
    source,
    `      const phone = source?.dtype === "phone"
        ? text(data.number || data.value)
        : firstInput(source, ["phone", "phone_number", "telephone", "mobile"]);`,
    `      const phone = source?.dtype === "phone"
        ? text(data.phone || data.number || data.value || data.main || source?.title)
        : firstInput(source, ["phone", "phone_number", "telephone", "mobile"]);`,
    "phone fallback"
  );

  source = replaceRequired(
    source,
    `      const ip = source?.dtype === "ip"
        ? text(data.address || data.value || data.ip)
        : firstInput(source, ["ip", "ip_address", "ipaddress", "address"]);`,
    `      const ip = source?.dtype === "ip"
        ? text(data.ip || data.address || data.value || data.main || source?.title)
        : firstInput(source, ["ip", "ip_address", "ipaddress", "address"]);`,
    "IP fallback"
  );

  source = replaceRequired(
    source,
    `      const mak = firstInput(source, ["mak", "melissa_address_key", "address_key"]);
      const mik = firstInput(source, ["mik", "melissa_identity_key", "identity_key"]);
      const latitude = firstInput(source, ["latitude", "lat"]);
      const longitude = firstInput(source, ["longitude", "long", "lng", "lon"]);
      const apn = firstInput(source, ["apn", "parcel_number", "parcel"]);
      const fips = firstInput(source, ["fips", "county_fips"]);
      const account = firstInput(source, ["account", "account_number"]);`,
    `      const mak = firstInput(source, ["mak", "melissa_address_key", "address_key"])
        || externalIdValue(source, ["mak", "melissa-address-key", "address-key"]);
      const mik = firstInput(source, ["mik", "melissa_identity_key", "identity_key"])
        || externalIdValue(source, ["mik", "melissa-identity-key", "identity-key"]);
      const coordinates = Array.isArray(data.coordinates)
        ? data.coordinates
        : Array.isArray(data.geometry?.coordinates) ? data.geometry.coordinates : [];
      const latitude = firstInput(source, ["latitude", "lat"])
        || (coordinates.length >= 2 ? coordinates[1] : "");
      const longitude = firstInput(source, ["longitude", "long", "lng", "lon"])
        || (coordinates.length >= 2 ? coordinates[0] : "");
      const apn = firstInput(source, ["apn", "parcel_number", "parcel"])
        || externalIdValue(source, ["apn", "assessor-parcel-number", "parcel-number"]);
      const fips = firstInput(source, ["fips", "county_fips"])
        || externalIdValue(source, ["fips", "county-fips"]);
      const account = firstInput(source, ["account", "account_number"])
        || externalIdValue(source, ["account", "account-number"]);`,
    "identifier and coordinate fallbacks"
  );

  source = replaceRequired(
    source,
    `        append(url, "ff", firstInput(source, ["free_form", "freeform", "ff"]));`,
    `        append(url, "ff", firstInput(source, ["free_form", "freeform", "ff"])
          || (["location", "address", "asset"].includes(source?.dtype)
            ? text(data.address || data.value || data.main || source?.title)
            : ""));`,
    "property free-form fallback"
  );

  source = replaceRequired(
    source,
    `      if (address) addRelated("location", address, address, primaryData("location", fields), "located-at");
      if (fields.phone) addRelated("phone", fields.phone, fields.phone, primaryData("phone", fields), "has-phone");
      if (fields.email) addRelated("email", fields.email.toLowerCase(), fields.email, primaryData("email", fields), "has-email");
      return related;`,
    `      if (address) addRelated("location", address, address, primaryData("location", fields), "located-at");
      if (fields.phone) addRelated("phone", fields.phone, fields.phone, primaryData("phone", fields), "has-phone");
      if (fields.email) addRelated("email", fields.email.toLowerCase(), fields.email, primaryData("email", fields), "has-email");
      if (fields.company && !primaryId.startsWith("starintel:org:")) {
        addRelated("org", fields.company.toLowerCase(), fields.company, primaryData("org", fields), "associated-with");
      }
      return related;`,
    "linked organization documents"
  );

  source = replaceRequired(
    source,
    `    const validateInput = (url) => {
      const params = url.searchParams;
      if (SERVICE === "reverse-geocoder" && (!params.get("lat") || !params.get("long"))) throw new Error("Reverse geocoder requires latitude and longitude");
      if (SERVICE === "global-phone" && !params.get("phone")) throw new Error("Global Phone requires a phone number");
      if (SERVICE === "global-email" && !params.get("email")) throw new Error("Global Email requires an email address");
      if (SERVICE === "global-ip" && !params.get("ip")) throw new Error("Global IP requires an IP address");
      if (SERVICE === "global-name" && !params.get("full") && !params.get("comp")) throw new Error("Global Name requires a person or company name");
      if (SERVICE === "global-address" && !params.get("a1") && !params.get("postal")) throw new Error("Global Address requires address input");
      if (SERVICE === "people-business-search" && !params.get("anyname") && !params.get("a1") && !params.get("postal")) throw new Error("People Business Search requires a name or address");
      if (SERVICE === "personator-search" && !["full", "a1", "email", "phone", "mak", "mik"].some((key) => params.get(key))) throw new Error("Personator Search could not extract a name, address, email, phone, MAK, or MIK from the selected document");
      if (SERVICE === "property" && !["mak", "addresskey", "a1", "apn", "fips", "account", "ff"].some((key) => params.get(key))) throw new Error("Property lookup requires an address, MAK, APN/FIPS, account, or free-form input");
    };`,
    `    const validateInput = (url) => {
      const params = url.searchParams;
      const has = (...keys) => keys.some((key) => params.get(key));
      const missing = (service, input) => {
        throw new Error(service + " could not extract " + input + " from the selected document");
      };
      if (SERVICE === "reverse-geocoder" && (!params.get("lat") || !params.get("long"))) missing("Reverse geocoder", "latitude and longitude");
      if (SERVICE === "global-phone" && !params.get("phone")) missing("Global Phone", "a phone number");
      if (SERVICE === "global-email" && !params.get("email")) missing("Global Email", "an email address");
      if (SERVICE === "global-ip" && !params.get("ip")) missing("Global IP", "an IP address");
      if (SERVICE === "global-name" && !has("full", "comp")) missing("Global Name", "a person or company name");
      if (SERVICE === "global-address" && !has("a1", "postal")) missing("Global Address", "address input");
      if (SERVICE === "people-business-search" && !has("anyname", "a1", "postal")) missing("People Business Search", "a name or address");
      if (SERVICE === "personator-search" && !has("full", "a1", "email", "phone", "mak", "mik")) missing("Personator Search", "a name, address, email, phone, MAK, or MIK");
      if (SERVICE === "personator-consumer" && !has("full", "first", "last", "comp", "a1", "postal", "email", "phone", "ip", "mak", "mik")) missing("Personator Consumer", "a name, company, address, email, phone, IP, MAK, or MIK");
      if (SERVICE === "personator-identity" && !has("full", "a1", "postal", "email", "phone")) missing("Personator Identity", "a name, address, email, or phone");
      if (SERVICE === "property" && !has("mak", "addresskey", "a1", "apn", "fips", "account", "ff")) missing("Property lookup", "an address, MAK, APN/FIPS, account, or free-form value");
    };`,
    "service validation"
  );

  source = replaceRequired(
    source,
    `      const records = recordsFrom(response.body);
      const transmissionResults = findValue(response.body, ["TransmissionResults", "TransmissionResult"]);
      const dataset = source.dataset || "melissa";`,
    `      const transmissionResults = findValue(response.body, ["TransmissionResults", "TransmissionResult"]);
      const resultCodes = (value) => text(value).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
      const transmissionError = resultCodes(transmissionResults).find((code) => /^(GE|SE)\\d{2}$/.test(code));
      if (transmissionError) {
        const descriptions = {
          GE01: "empty request",
          GE02: "empty request record",
          GE03: "record limit exceeded",
          GE04: "empty license key",
          GE05: "invalid license key",
          GE06: "disabled license key",
          GE07: "invalid request",
          GE08: "product or service level not enabled",
          GE09: "customer does not exist",
          GE10: "customer license disabled",
          GE11: "customer disabled",
          GE12: "request IP blacklisted",
          GE13: "request IP not whitelisted",
          GE14: "out of credits",
          SE01: "Melissa service error"
        };
        throw new Error(
          "Melissa " + SPEC.label + " failed: " + transmissionError +
          " (" + (descriptions[transmissionError] || "service-level error") + ")"
        );
      }
      const records = recordsFrom(response.body);
      const dataset = source.dataset || "melissa";`,
    "transmission error rejection"
  );

  source = replaceRequired(
    source,
    `        const fields = fieldsFrom(record, source, url);
        const kind = primaryKind(record);`,
    `        const recordResults = findValue(record, ["Results", "ResultCodes", "Status"]);
        const recordErrors = resultCodes(recordResults).filter((code) => /^[A-Z]E\\d{2}$/.test(code));
        if (recordErrors.length > 0) continue;
        const fields = fieldsFrom(record, source, url);
        const kind = primaryKind(record);`,
    "record error filtering"
  );

  return source;
}

export const MELISSA_ACTORS = Object.freeze(
  BASE_MELISSA_ACTORS.map((actor) =>
    Object.freeze({
      ...actor,
      version: MELISSA_ACTOR_PACK_VERSION,
      source: normalizeActorSource(actor)
    })
  )
);

export const MELISSA_ACTOR_IDS = Object.freeze(MELISSA_ACTORS.map((actor) => actor.id));

export function mergeMelissaActors(actors = []) {
  const ids = new Set(MELISSA_ACTOR_IDS);
  return [...actors.filter((actor) => !ids.has(actor?.id)), ...MELISSA_ACTORS];
}

export function removeMelissaActors(actors = []) {
  const ids = new Set(MELISSA_ACTOR_IDS);
  return actors.filter((actor) => !ids.has(actor?.id));
}

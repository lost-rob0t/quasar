async function personatorSearchActor(context, api) {
  const SERVICE = "personator-search";
  const ACTOR_ID = "quasar.actor.melissa-personator-search";
  const LABEL = "Personator Search";
  const TRANSMISSION_ERRORS = Object.freeze({
    GE01: "empty request structure",
    GE02: "empty request record structure",
    GE03: "records per request exceeded",
    GE04: "empty license key",
    GE05: "invalid license key",
    GE06: "disabled license key",
    GE07: "invalid request",
    GE08: "product or level not enabled",
    GE09: "customer does not exist",
    GE10: "customer license disabled",
    GE11: "customer disabled",
    GE12: "request IP blacklisted",
    GE13: "request IP not whitelisted",
    GE14: "out of credits",
    GE15: "unacceptable license key",
    GE20: "verify package not activated",
    GE21: "append package not activated",
    GE22: "move package not activated",
    GE23: "no valid action requested",
    GE24: "demographics package not activated",
    GE25: "business demographics not licensed",
    GE26: "Caller ID not enabled",
    GE27: "IP columns not activated",
    GE28: "SSN verification not activated",
    GE29: "requested fields unavailable for credit license",
    GE57: "Melissa Cloud API internal error",
    SE01: "Melissa Cloud API internal error"
  });
  const selected = Array.isArray(context.selection) ? context.selection.slice(0, 16) : [];
  const documents = [];
  const documentIds = new Set();

  const text = (value) => (value === undefined || value === null ? "" : String(value).trim());
  const cleanKey = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const compact = (value) =>
    Object.fromEntries(
      Object.entries(value).filter(([, item]) => {
        if (item === undefined || item === null) return false;
        if (typeof item === "string") return item.trim().length > 0;
        if (Array.isArray(item)) return item.length > 0;
        return true;
      })
    );
  const hash = (value) => {
    let state = 0x811c9dc5;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      state ^= source.charCodeAt(index);
      state = Math.imul(state, 0x01000193);
    }
    return (state >>> 0).toString(36);
  };
  const scalar = (value) => {
    if (Array.isArray(value)) return scalar(value[0]);
    if (value && typeof value === "object") {
      return text(value.value || value.Value || value.name || value.Name || value.address || value.Address);
    }
    return text(value);
  };
  const findValue = (object, names, depth = 0) => {
    if (!object || typeof object !== "object" || depth > 4) return "";
    const wanted = new Set(names.map(cleanKey));
    for (const [key, value] of Object.entries(object)) {
      if (!wanted.has(cleanKey(key))) continue;
      const candidate = scalar(value);
      if (candidate) return candidate;
    }
    for (const value of Object.values(object)) {
      if (!value || typeof value !== "object") continue;
      const candidate = findValue(value, names, depth + 1);
      if (candidate) return candidate;
    }
    return "";
  };
  const inputValue = (source, names) =>
    findValue(source?.data || {}, names) || findValue(source || {}, names);
  const externalIdValue = (source, schemes) => {
    const identifiers = source?.data?.external_ids || source?.external_ids || [];
    if (!Array.isArray(identifiers)) return "";
    const wanted = new Set(schemes.map(cleanKey));
    for (const identifier of identifiers) {
      if (!identifier || typeof identifier !== "object") continue;
      if (!wanted.has(cleanKey(identifier.scheme || identifier.type || identifier.name))) continue;
      const value = scalar(identifier.value || identifier.id || identifier.key);
      if (value) return value;
    }
    return "";
  };
  const append = (url, key, value) => {
    const normalized = text(value);
    if (normalized) url.searchParams.set(key, normalized);
  };
  const resultCodes = (value) =>
    text(value)
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean);
  const addDocument = (document) => {
    if (!document?._id || documentIds.has(document._id)) return;
    documentIds.add(document._id);
    documents.push(document);
  };
  const baseDocument = (id, dataset, dtype, title, data, stamp, extensions, summary = "") => ({
    _id: id,
    dataset,
    dtype,
    schema_version: "0.9.0",
    version: 1,
    date_added: stamp,
    date_updated: stamp,
    title,
    ...(summary ? { summary } : {}),
    sources: [],
    evidence: [],
    data,
    extensions
  });
  const relationDocument = (id, dataset, subject, predicate, object, stamp, extensions) =>
    baseDocument(
      id,
      dataset,
      "relation",
      predicate,
      { subject, predicate, object, source: subject, target: object, directed: true },
      stamp,
      extensions
    );
  const displayAddress = (address) =>
    [address?.AddressLine1, address?.Suite, address?.City, address?.State, address?.PostalCode]
      .map(text)
      .filter(Boolean)
      .join(", ");
  const normalizeDob = (value) => {
    const digits = text(value).replace(/\D/g, "");
    if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (digits.length === 6) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-01`;
    if (digits.length === 4) return `${digits}-01-01`;
    return "";
  };
  const splitFullName = (full) => {
    const parts = text(full).replace(/\s+/g, " ").split(" ").filter(Boolean);
    if (parts.length < 2) return { first: "", last: parts[0] || "" };
    return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
  };
  const buildUrl = (source) => {
    const data = source?.data || {};
    let first = inputValue(source, ["first_name", "firstname", "given_name", "fname"]);
    const middle = inputValue(source, ["middle_name", "middlename", "mname"]);
    let last = inputValue(source, ["last_name", "lastname", "family_name", "surname", "lname"]);
    let full = inputValue(source, ["full_name", "fullname", "name", "display_name", "main", "preferred_name"]);
    if (!full && source?.dtype === "person") full = text(source.title);
    if ((!first || !last) && full) {
      const split = splitFullName(full);
      first ||= split.first;
      last ||= split.last;
    }
    if (!full) full = [first, middle, last].filter(Boolean).join(" ");

    const address1 = inputValue(source, ["address_line_1", "address1", "a1", "street"]);
    const city = inputValue(source, ["city", "locality", "loc"]);
    const state = inputValue(source, ["state", "administrative_area", "adminarea", "region"]);
    const postal = inputValue(source, ["postal", "postal_code", "postcode", "zip", "zipcode"]);
    const freeForm =
      inputValue(source, ["free_form", "freeform", "ff"]) ||
      (["location", "address", "asset"].includes(source?.dtype)
        ? text(data.address || data.value || data.main || source.title)
        : "");
    const email =
      source?.dtype === "email"
        ? text(data.email || data.address || data.value || data.main || source.title)
        : inputValue(source, ["email", "email_address"]);
    const phone =
      source?.dtype === "phone"
        ? text(data.phone || data.number || data.value || data.main || source.title)
        : inputValue(source, ["phone", "phone_number", "telephone", "mobile"]);
    const mak =
      inputValue(source, ["mak", "melissa_address_key", "address_key"]) ||
      externalIdValue(source, ["mak", "melissa-address-key", "address-key"]);
    const mik =
      inputValue(source, ["mik", "melissa_identity_key", "identity_key"]) ||
      externalIdValue(source, ["mik", "melissa-identity-key", "identity-key"]);
    const dob = inputValue(source, ["dob", "date_of_birth", "birth_date", "birthday"]);
    const dobDigits = text(dob).replace(/\D/g, "");

    const url = new URL("https://personatorsearch.melissadata.net/WEB/doPersonatorSearch");
    append(url, "full", full);
    append(url, "first", first);
    append(url, "last", last);
    append(url, "a1", address1);
    append(url, "city", city);
    append(url, "state", state);
    append(url, "postal", postal);
    append(url, "ff", freeForm);
    append(url, "email", email);
    append(url, "phone", phone);
    append(url, "mak", mak);
    append(url, "mik", mik);
    append(url, "ageapprox", inputValue(source, ["age_approx", "ageapprox", "age"]));
    append(url, "agegt", inputValue(source, ["age_gt", "agegt"]));
    append(url, "agelt", inputValue(source, ["age_lt", "agelt"]));
    append(url, "byear", inputValue(source, ["birth_year", "byear"]) || (dobDigits.length >= 4 ? dobDigits.slice(0, 4) : ""));
    append(url, "bmonth", inputValue(source, ["birth_month", "bmonth"]) || (dobDigits.length >= 6 ? dobDigits.slice(4, 6) : ""));
    append(url, "bday", inputValue(source, ["birth_day", "bday"]) || (dobDigits.length >= 8 ? dobDigits.slice(6, 8) : ""));
    url.searchParams.set("format", "JSON");
    return url;
  };
  const validateInput = (url) => {
    const params = url.searchParams;
    const valid =
      (params.get("a1") && params.get("postal")) ||
      (params.get("a1") && params.get("city") && params.get("state")) ||
      params.get("ff") ||
      params.get("last") ||
      params.get("phone") ||
      params.get("email") ||
      params.get("mak") ||
      params.get("mik");
    if (!valid) {
      throw new Error(
        "Personator Search requires a last name, phone, email, MAK, MIK, free-form input, or a complete address search set"
      );
    }
  };
  const transmissionError = (body) => {
    const codes = resultCodes(body?.TransmissionResults || body?.TransmissionResult);
    const code = codes.find((candidate) => /^(GE|SE)\d{2}$/.test(candidate));
    if (!code) return null;
    return new Error(`Melissa ${LABEL} failed: ${code} (${TRANSMISSION_ERRORS[code] || "service-level error"})`);
  };

  let matchCount = 0;
  let skippedCount = 0;

  for (let sourceIndex = 0; sourceIndex < selected.length; sourceIndex += 1) {
    const source = selected[sourceIndex];
    const url = buildUrl(source);
    validateInput(url);
    api.progress(
      sourceIndex / Math.max(selected.length, 1),
      `Melissa ${LABEL}: ${source.title || source._id}`
    );
    const response = await api.network.fetch({
      url: url.href,
      responseType: "json",
      options: { headers: { accept: "application/json" } }
    });
    if (!response.ok) throw new Error(`Melissa ${LABEL} returned HTTP ${response.status}`);
    const body = response.body && typeof response.body === "object" ? response.body : {};
    const fatal = transmissionError(body);
    if (fatal) throw fatal;

    const serviceCodes = resultCodes(body.TransmissionResults || body.TransmissionResult);
    const serviceWarnings = serviceCodes.filter((code) => /^GW\d{2}$/.test(code));
    const records = Array.isArray(body.Records) ? body.Records : [];
    const dataset = source.dataset || "melissa";
    const stamp = new Date().toISOString();

    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      const record = records[recordIndex];
      if (!record || typeof record !== "object") continue;
      const recordCodes = resultCodes(record.Results);
      if (recordCodes.some((code) => /^UE\d{2}$/.test(code))) {
        skippedCount += 1;
        continue;
      }

      const fullName = text(record.FullName) ||
        [record.FirstName, record.MiddleName, record.LastName, record.Suffix].map(text).filter(Boolean).join(" ");
      const currentAddress = record.CurrentAddress && typeof record.CurrentAddress === "object"
        ? record.CurrentAddress
        : {};
      const mik = text(record.MelissaIdentityKey);
      const stablePersonKey =
        mik ||
        [fullName, displayAddress(currentAddress), text(record.DateOfBirth), text(record.RecordID)]
          .filter(Boolean)
          .join("\0") ||
        `${source._id}\0${recordIndex}`;
      const personId = `starintel:person:melissa-personator-search-${hash(stablePersonKey)}`;
      const actorExtension = {
        actor_id: ACTOR_ID,
        input_ids: [source._id],
        generated: true,
        service: SERVICE
      };
      const externalIds = [
        mik ? { scheme: "melissa-identity-key", value: mik, issuer: "Melissa" } : null,
        text(record.RecordID)
          ? { scheme: "melissa-record-id", value: text(record.RecordID), issuer: "Melissa" }
          : null
      ].filter(Boolean);
      const primaryExtensions = {
        "quasar.actor": actorExtension,
        "melissa.api": {
          service: SERVICE,
          request_url: url.href,
          transmission_reference: text(body.TransmissionReference),
          transmission_results: serviceCodes,
          transmission_warnings: serviceWarnings,
          total_pages: text(body.TotalPages),
          total_records: text(body.TotalRecords),
          service_version: text(body.Version),
          record
        }
      };
      addDocument(
        baseDocument(
          personId,
          dataset,
          "person",
          fullName || "Melissa person result",
          compact({
            name: fullName || "Melissa person result",
            full_name: fullName || "Melissa person result",
            fname: text(record.FirstName),
            mname: text(record.MiddleName),
            lname: text(record.LastName),
            dob: normalizeDob(record.DateOfBirth),
            etype: "person",
            status: recordCodes.join(",") || "api-result",
            description: "Melissa Personator Search result",
            external_ids: externalIds
          }),
          stamp,
          primaryExtensions,
          `Melissa Personator Search result for ${source.title || source._id}`
        )
      );
      const matchRelationId = `starintel:relation:melissa-personator-search-${hash(`${source._id}\0matched-to\0${personId}`)}`;
      addDocument(
        relationDocument(
          matchRelationId,
          dataset,
          source._id,
          "matched-to",
          personId,
          stamp,
          {
            "quasar.actor": actorExtension,
            "melissa.api": { service: SERVICE, result_id: personId, result_codes: recordCodes }
          }
        )
      );

      const addAddress = (address, predicate, current) => {
        if (!address || typeof address !== "object") return;
        const display = displayAddress(address);
        const mak = text(address.MelissaAddressKey);
        if (!display && !mak) return;
        const addressKey = mak || display;
        const locationId = `starintel:location:melissa-personator-search-${hash(addressKey)}`;
        const relationId = `starintel:relation:melissa-personator-search-${hash(`${personId}\0${predicate}\0${locationId}`)}`;
        const extension = {
          "quasar.actor": actorExtension,
          "melissa.api": {
            service: SERVICE,
            parent_result_id: personId,
            current,
            move_date: text(address.MoveDate),
            record: address
          }
        };
        addDocument(
          baseDocument(
            locationId,
            dataset,
            "location",
            display || mak,
            compact({
              name: display || mak,
              address: display,
              street: text(address.AddressLine1),
              street2: text(address.Suite),
              city: text(address.City),
              state: text(address.State),
              region: text(address.State),
              postal: [text(address.PostalCode), text(address.Plus4)].filter(Boolean).join("-"),
              location_type: "address"
            }),
            stamp,
            extension,
            current ? "Current address returned by Melissa" : "Previous address returned by Melissa"
          )
        );
        addDocument(
          relationDocument(relationId, dataset, personId, predicate, locationId, stamp, extension)
        );
      };

      addAddress(currentAddress, "located-at", true);
      for (const address of Array.isArray(record.PreviousAddresses) ? record.PreviousAddresses : []) {
        addAddress(address, "previously-located-at", false);
      }

      const phones = new Set();
      for (const phoneRecord of Array.isArray(record.PhoneRecords) ? record.PhoneRecords : []) {
        const number = text(phoneRecord?.phoneNumber || phoneRecord?.PhoneNumber || phoneRecord);
        if (!number || phones.has(number)) continue;
        phones.add(number);
        const phoneId = `starintel:phone:melissa-personator-search-${hash(number)}`;
        const relationId = `starintel:relation:melissa-personator-search-${hash(`${personId}\0has-phone\0${phoneId}`)}`;
        const extension = {
          "quasar.actor": actorExtension,
          "melissa.api": { service: SERVICE, parent_result_id: personId, record: phoneRecord }
        };
        addDocument(
          baseDocument(
            phoneId,
            dataset,
            "phone",
            number,
            { number, value: number, status: recordCodes.join(",") || "api-result" },
            stamp,
            extension,
            "Phone returned by Melissa Personator Search"
          )
        );
        addDocument(relationDocument(relationId, dataset, personId, "has-phone", phoneId, stamp, extension));
      }

      const emails = new Set();
      for (const emailRecord of Array.isArray(record.EmailRecords) ? record.EmailRecords : []) {
        const address = text(emailRecord?.email || emailRecord?.Email || emailRecord).toLowerCase();
        if (!address || emails.has(address)) continue;
        emails.add(address);
        const parts = address.split("@");
        const emailId = `starintel:email:melissa-personator-search-${hash(address)}`;
        const relationId = `starintel:relation:melissa-personator-search-${hash(`${personId}\0has-email\0${emailId}`)}`;
        const extension = {
          "quasar.actor": actorExtension,
          "melissa.api": { service: SERVICE, parent_result_id: personId, record: emailRecord }
        };
        addDocument(
          baseDocument(
            emailId,
            dataset,
            "email",
            address,
            compact({
              address,
              value: address,
              user: parts.length === 2 ? parts[0] : "",
              domain: parts.length === 2 ? parts[1] : "",
              status: recordCodes.join(",") || "api-result"
            }),
            stamp,
            extension,
            "Email returned by Melissa Personator Search"
          )
        );
        addDocument(relationDocument(relationId, dataset, personId, "has-email", emailId, stamp, extension));
      }

      matchCount += 1;
    }
  }

  api.progress(1, "Melissa person search complete");
  const resultDocuments = documents.filter((document) => document.dtype !== "relation").length;
  const relations = documents.length - resultDocuments;
  return {
    documents,
    message:
      matchCount === 0
        ? "Melissa Personator Search returned no usable matches."
        : `Created ${resultDocuments} Melissa document(s) and ${relations} relation(s) from ${matchCount} match(es).`,
    metrics: {
      inputs: selected.length,
      outputs: documents.length,
      matches: matchCount,
      skipped: skippedCount,
      service: SERVICE
    }
  };
}

export const MELISSA_PERSONATOR_SEARCH_SOURCE = personatorSearchActor.toString();

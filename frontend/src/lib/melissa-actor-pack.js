export const MELISSA_ACTOR_PACK_VERSION = 2;

const SERVICES = Object.freeze({
  "personator-search": {
    id: "quasar.actor.melissa-personator-search",
    label: "Melissa person search",
    description:
      "Resolve people from names, addresses, email, phone, MAK, or MIK with Personator Search.",
    accepts: ["person", "org", "entity", "target", "location", "address", "email", "phone"],
    predicate: "matched-to"
  },
  "people-business-search": {
    id: "quasar.actor.melissa-people-business-search",
    label: "Melissa people and business search",
    description:
      "Search partial person, organization, and address data with Melissa People Business Search.",
    accepts: ["person", "org", "entity", "target", "location", "address"],
    predicate: "matched-to"
  },
  "personator-consumer": {
    id: "quasar.actor.melissa-personator-consumer",
    label: "Melissa consumer verify and append",
    description:
      "Check, verify, append, or move-match names, addresses, phones, and emails with Personator Consumer.",
    accepts: ["person", "org", "entity", "target", "location", "address", "email", "phone"],
    predicate: "verified-as"
  },
  "personator-identity": {
    id: "quasar.actor.melissa-personator-identity",
    label: "Melissa identity check",
    description:
      "Check or screen a global identity using name, address, phone, and email evidence.",
    accepts: ["person", "entity", "target", "location", "address", "email", "phone"],
    predicate: "identity-check-result"
  },
  "reverse-geocoder": {
    id: "quasar.actor.melissa-reverse-geocoder",
    label: "Melissa reverse geocoder",
    description: "Resolve latitude and longitude coordinates to nearby validated addresses.",
    accepts: ["location", "address", "entity", "target"],
    predicate: "nearby-address"
  },
  property: {
    id: "quasar.actor.melissa-property",
    label: "Melissa property lookup",
    description:
      "Retrieve parcel, ownership, assessment, mortgage, sale, and physical property data.",
    accepts: ["location", "address", "entity", "target", "person"],
    predicate: "property-record"
  },
  "global-address": {
    id: "quasar.actor.melissa-global-address",
    label: "Melissa global address verification",
    description: "Verify, correct, standardize, parse, and geocode a global address.",
    accepts: ["location", "address", "entity", "target", "person", "org"],
    predicate: "normalized-as"
  },
  "global-name": {
    id: "quasar.actor.melissa-global-name",
    label: "Melissa global name",
    description: "Parse, standardize, validate, and enrich person or company names.",
    accepts: ["person", "org", "entity", "target"],
    predicate: "normalized-as"
  },
  "global-phone": {
    id: "quasar.actor.melissa-global-phone",
    label: "Melissa global phone",
    description:
      "Validate and enrich phone numbers with carrier, line type, geographic, and caller data.",
    accepts: ["phone", "person", "org", "entity", "target"],
    predicate: "has-phone-result"
  },
  "global-email": {
    id: "quasar.actor.melissa-global-email",
    label: "Melissa global email",
    description: "Validate and correct email addresses, domains, and mailbox status.",
    accepts: ["email", "person", "org", "entity", "target"],
    predicate: "has-email-result"
  },
  "global-ip": {
    id: "quasar.actor.melissa-global-ip",
    label: "Melissa global IP",
    description: "Geolocate IP addresses and identify ISP, proxy, TOR, and connection metadata.",
    accepts: ["ip", "network", "entity", "target", "person", "org"],
    predicate: "resolved-to"
  }
});

function buildMelissaActorSource(service) {
  return `async (context, api) => {
    const SERVICE = ${JSON.stringify(service)};
    const SPEC = ${JSON.stringify(SERVICES[service])};
    const selected = Array.isArray(context.selection) ? context.selection.slice(0, 16) : [];
    const documents = [];
    const documentIds = new Set();

    const text = (value) => value === undefined || value === null ? "" : String(value).trim();
    const cleanKey = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => {
      if (item === undefined || item === null) return false;
      if (typeof item === "string") return item.trim().length > 0;
      if (Array.isArray(item)) return item.length > 0;
      return true;
    }));
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
        if (wanted.has(cleanKey(key))) {
          const candidate = scalar(value);
          if (candidate) return candidate;
        }
      }
      for (const value of Object.values(object)) {
        if (!value || typeof value !== "object") continue;
        const nested = findValue(value, names, depth + 1);
        if (nested) return nested;
      }
      return "";
    };
    const firstInput = (source, names) => findValue(source?.data || {}, names) || findValue(source || {}, names);
    const append = (url, key, value) => {
      const normalized = text(value);
      if (normalized) url.searchParams.set(key, normalized);
    };
    const numberOrEmpty = (value) => {
      const normalized = Number(value);
      return text(value) && Number.isFinite(normalized) ? normalized : "";
    };
    const normalizedConfidence = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return undefined;
      if (number <= 1) return number;
      if (number <= 10) return number / 10;
      if (number <= 100) return number / 100;
      return undefined;
    };
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
    const relationDocument = (id, dataset, subject, predicate, object, stamp, extensions, confidence) => baseDocument(
      id,
      dataset,
      "relation",
      predicate,
      compact({
        subject,
        predicate,
        object,
        source: subject,
        target: object,
        directed: true,
        confidence: normalizedConfidence(confidence)
      }),
      stamp,
      extensions
    );
    const externalIds = (record) => [
      ["melissa-address-key", findValue(record, ["MelissaAddressKey", "AddressKey", "MAK"])],
      ["melissa-identity-key", findValue(record, ["MelissaIdentityKey", "IdentityKey", "MIK"])],
      ["assessor-parcel-number", findValue(record, ["APN", "ParcelNumber", "AssessorParcelNumber"])],
      ["fips", findValue(record, ["FIPS", "CountyFIPS"])],
      ["melissa-record-id", findValue(record, ["RecordID", "RecordId"])]
    ].filter(([, value]) => value).map(([scheme, value]) => ({ scheme, value, issuer: "Melissa" }));
    const fieldsFrom = (record, source, url) => {
      const sourceData = source?.data || {};
      const emailFromSource = source?.dtype === "email" ? text(sourceData.address || sourceData.value) : "";
      const phoneFromSource = source?.dtype === "phone" ? text(sourceData.number || sourceData.value) : "";
      const ipFromSource = source?.dtype === "ip" ? text(sourceData.address || sourceData.value || sourceData.ip) : "";
      const addressFromSource = ["location", "address"].includes(source?.dtype)
        ? text(sourceData.street || sourceData.address)
        : "";
      return {
        fullName: findValue(record, ["FullName", "NameFull", "Name", "Full"]),
        firstName: findValue(record, ["FirstName", "NameFirst", "GivenName"]),
        middleName: findValue(record, ["MiddleName", "NameMiddle"]),
        lastName: findValue(record, ["LastName", "NameLast", "FamilyName", "Surname"]),
        company: findValue(record, ["CompanyName", "Company", "Organization", "BusinessName"]),
        ownerName: findValue(record, ["PrimaryOwnerName", "OwnerName", "Owner1FullName", "OwnerFullName"]),
        ownerType: findValue(record, ["OwnerType", "PrimaryOwnerType", "OwnerEntityType"]),
        address1: findValue(record, ["AddressLine1", "Address1", "DeliveryAddress", "StreetAddress"]) || addressFromSource,
        address2: findValue(record, ["AddressLine2", "Address2", "Suite"]),
        city: findValue(record, ["City", "Locality"]),
        state: findValue(record, ["State", "AdministrativeArea", "Region"]),
        postal: findValue(record, ["PostalCode", "Zip", "ZIPCode"]),
        country: findValue(record, ["CountryAbbreviation", "CountryCode", "CountryISO3166_1_Alpha2", "Country"]),
        latitude: findValue(record, ["Latitude", "Lat"]),
        longitude: findValue(record, ["Longitude", "Long", "Lng", "Lon"]),
        phone: findValue(record, ["PhoneNumber", "Phone", "NewPhone", "InternationalPhoneNumber"]) || phoneFromSource || url.searchParams.get("phone") || "",
        email: findValue(record, ["EmailAddress", "Email", "NewEmail"]) || emailFromSource || url.searchParams.get("email") || "",
        ip: findValue(record, ["IPAddress", "IP"]) || ipFromSource || url.searchParams.get("ip") || "",
        carrier: findValue(record, ["Carrier", "CarrierName", "PhoneCarrier"]),
        phoneType: findValue(record, ["PhoneType", "LineType", "PhoneTypeDescription"]),
        isp: findValue(record, ["ISPName", "ISP", "InternetServiceProvider", "Organization"]),
        status: findValue(record, ["Results", "ResultCodes", "Status", "EmailStatus", "PhoneStatus"]) || "api-result",
        confidence: findValue(record, ["Confidence", "MatchScore", "MatchLevel"]),
        externalIds: externalIds(record)
      };
    };
    const displayAddress = (fields) => [fields.address1, fields.city, fields.state, fields.postal].filter(Boolean).join(", ");
    const displayPerson = (fields) => fields.fullName || [fields.firstName, fields.middleName, fields.lastName].filter(Boolean).join(" ");
    const primaryKind = (record) => {
      if (["reverse-geocoder", "global-address"].includes(SERVICE)) return "location";
      if (SERVICE === "property") return "asset";
      if (SERVICE === "global-phone") return "phone";
      if (SERVICE === "global-email") return "email";
      if (SERVICE === "global-ip") return "entity";
      const company = findValue(record, ["CompanyName", "Company", "Organization", "BusinessName"]);
      const person = findValue(record, ["FullName", "NameFull", "FirstName", "LastName"]);
      return company && !person ? "org" : "person";
    };
    const primaryData = (kind, fields) => {
      const personName = displayPerson(fields);
      const address = displayAddress(fields);
      if (kind === "person") return compact({
        name: personName || fields.company || "Melissa person result",
        full_name: personName || fields.company || "Melissa person result",
        fname: fields.firstName,
        mname: fields.middleName,
        lname: fields.lastName,
        country: fields.country,
        etype: "person",
        status: fields.status,
        description: "Melissa " + SERVICE + " result",
        external_ids: fields.externalIds
      });
      if (kind === "org") return compact({
        name: fields.company || personName || "Melissa organization result",
        display_name: fields.company || personName,
        country: fields.country,
        etype: "organization",
        org_type: "business",
        status: fields.status,
        description: "Melissa " + SERVICE + " result",
        external_ids: fields.externalIds
      });
      if (kind === "location") return compact({
        name: address || "Melissa address result",
        address,
        street: fields.address1,
        street2: fields.address2,
        city: fields.city,
        state: fields.state,
        region: fields.state,
        postal: fields.postal,
        country: fields.country,
        country_code: fields.country,
        lat: numberOrEmpty(fields.latitude),
        long: numberOrEmpty(fields.longitude),
        location_type: "address"
      });
      if (kind === "asset") return compact({
        name: address || fields.externalIds.find((item) => item.scheme === "assessor-parcel-number")?.value || "Melissa property result",
        asset_type: "property",
        country: fields.country,
        status: fields.status,
        description: "Melissa property record",
        external_ids: fields.externalIds
      });
      if (kind === "phone") return compact({
        number: fields.phone,
        value: fields.phone,
        carrier: fields.carrier,
        country_code: fields.country,
        phone_type: fields.phoneType,
        status: fields.status
      });
      if (kind === "email") {
        const parts = fields.email.split("@");
        return compact({
          address: fields.email,
          value: fields.email,
          user: parts.length === 2 ? parts[0] : "",
          domain: parts.length === 2 ? parts[1] : "",
          status: fields.status
        });
      }
      return compact({
        name: fields.ip || "Melissa IP result",
        etype: "ip-address",
        country: fields.country,
        status: fields.status,
        description: fields.isp ? "ISP: " + fields.isp : "Melissa Global IP result",
        external_ids: fields.ip ? [{ scheme: "ip-address", value: fields.ip, issuer: "Melissa" }] : []
      });
    };
    const titleFor = (kind, fields) => {
      if (kind === "person") return displayPerson(fields) || fields.company || "Melissa person result";
      if (kind === "org") return fields.company || displayPerson(fields) || "Melissa organization result";
      if (kind === "location" || kind === "asset") return displayAddress(fields) || "Melissa " + kind + " result";
      if (kind === "phone") return fields.phone || "Melissa phone result";
      if (kind === "email") return fields.email || "Melissa email result";
      return fields.ip || "Melissa IP result";
    };
    const makeRelatedDocuments = (primaryId, dataset, fields, stamp, actorExtension) => {
      const related = [];
      const extension = { "quasar.actor": actorExtension, "melissa.api": { service: SERVICE, parent_result_id: primaryId } };
      const addRelated = (dtype, key, title, data, predicate) => {
        if (!key) return;
        const id = "starintel:" + dtype + ":melissa-" + SERVICE + "-" + hash(primaryId + "\\0" + dtype + "\\0" + key);
        const relationId = "starintel:relation:melissa-" + SERVICE + "-" + hash(primaryId + "\\0" + predicate + "\\0" + id);
        related.push(baseDocument(id, dataset, dtype, title, data, stamp, extension, "Structured Melissa contact or location result"));
        related.push(relationDocument(relationId, dataset, primaryId, predicate, id, stamp, extension, fields.confidence));
      };
      const address = displayAddress(fields);
      if (address) addRelated("location", address, address, primaryData("location", fields), "located-at");
      if (fields.phone) addRelated("phone", fields.phone, fields.phone, primaryData("phone", fields), "has-phone");
      if (fields.email) addRelated("email", fields.email.toLowerCase(), fields.email, primaryData("email", fields), "has-email");
      return related;
    };
    const buildUrl = (source) => {
      const data = source?.data || {};
      const first = firstInput(source, ["first_name", "firstname", "given_name", "fname"]);
      const middle = firstInput(source, ["middle_name", "middlename", "mname"]);
      const last = firstInput(source, ["last_name", "lastname", "family_name", "surname", "lname"]);
      const entityType = cleanKey(firstInput(source, ["etype", "entity_type", "entitytype", "object_type", "objecttype", "kind"]));
      const personLike = source?.dtype === "person" || entityType === "person";
      const organizationLike = source?.dtype === "org" || ["org", "organization", "company", "business"].includes(entityType);
      const explicitFull = firstInput(source, ["full_name", "fullname", "name", "display_name", "main", "preferred_name"]);
      const full = explicitFull || [first, middle, last].filter(Boolean).join(" ") || (personLike ? text(source?.title) : "");
      const company = firstInput(source, ["company", "company_name", "organization", "org", "legal_name"])
        || (organizationLike ? text(source?.title) : "");
      const address1 = ["email", "phone", "ip"].includes(source?.dtype)
        ? firstInput(source, ["address_line_1", "address1", "a1", "street"])
        : firstInput(source, ["address_line_1", "address1", "a1", "street", "address"]);
      const address2 = firstInput(source, ["address_line_2", "address2", "a2", "street2", "suite", "unit"]);
      const city = firstInput(source, ["city", "locality", "loc"]);
      const state = firstInput(source, ["state", "administrative_area", "adminarea", "admarea", "region"]);
      const postal = firstInput(source, ["postal", "postal_code", "postcode", "zip", "zipcode"]);
      const country = firstInput(source, ["country", "country_code", "ctry"]);
      const email = source?.dtype === "email"
        ? text(data.address || data.value)
        : firstInput(source, ["email", "email_address"]);
      const phone = source?.dtype === "phone"
        ? text(data.number || data.value)
        : firstInput(source, ["phone", "phone_number", "telephone", "mobile"]);
      const ip = source?.dtype === "ip"
        ? text(data.address || data.value || data.ip)
        : firstInput(source, ["ip", "ip_address", "ipaddress", "address"]);
      const mak = firstInput(source, ["mak", "melissa_address_key", "address_key"]);
      const mik = firstInput(source, ["mik", "melissa_identity_key", "identity_key"]);
      const latitude = firstInput(source, ["latitude", "lat"]);
      const longitude = firstInput(source, ["longitude", "long", "lng", "lon"]);
      const apn = firstInput(source, ["apn", "parcel_number", "parcel"]);
      const fips = firstInput(source, ["fips", "county_fips"]);
      const account = firstInput(source, ["account", "account_number"]);
      let url;

      if (SERVICE === "personator-search") {
        url = new URL("https://personatorsearch.melissadata.net/WEB/doPersonatorSearch");
        append(url, "full", full);
        append(url, "a1", address1);
        append(url, "city", city);
        append(url, "state", state);
        append(url, "postal", postal);
        append(url, "email", email);
        append(url, "phone", phone);
        append(url, "mak", mak);
        append(url, "mik", mik);
      } else if (SERVICE === "people-business-search") {
        url = new URL("https://search.melissadata.net/V5/WEB/contactsearch/docontactSearch");
        append(url, "anyname", company || full);
        append(url, "a1", address1);
        append(url, "loc", city);
        append(url, "adminarea", state);
        append(url, "postal", postal);
      } else if (SERVICE === "personator-consumer") {
        url = new URL("https://personator.melissadata.net/V3/WEB/ContactVerify/doContactVerify");
        append(url, "act", data.melissa_action || data.action);
        append(url, "opt", data.melissa_options);
        append(url, "cols", data.melissa_columns);
        append(url, "full", full);
        append(url, "first", first);
        append(url, "last", last);
        append(url, "comp", company);
        append(url, "a1", address1);
        append(url, "a2", address2);
        append(url, "city", city);
        append(url, "state", state);
        append(url, "postal", postal);
        append(url, "ctry", country);
        append(url, "email", email);
        append(url, "phone", phone);
        append(url, "ip", ip);
        append(url, "mak", mak);
        append(url, "mik", mik);
      } else if (SERVICE === "personator-identity") {
        url = new URL("https://globalpersonator.melissadata.net/v1/doContactVerify");
        append(url, "act", data.melissa_action || data.action);
        append(url, "full", full);
        append(url, "phone", phone);
        append(url, "email", email);
        append(url, "a1", address1);
        append(url, "a2", address2);
        append(url, "loc", city);
        append(url, "admarea", state);
        append(url, "postal", postal);
        append(url, "ctry", country);
      } else if (SERVICE === "reverse-geocoder") {
        url = new URL("https://reversegeo.melissadata.net/V3/WEB/ReverseGeoCode/doLookup");
        append(url, "lat", latitude);
        append(url, "long", longitude);
      } else if (SERVICE === "property") {
        url = new URL("https://property.melissadata.net/v4/WEB/LookupProperty");
        append(url, "mak", mak);
        append(url, "addresskey", firstInput(source, ["addresskey", "address_key"]));
        append(url, "a1", address1);
        append(url, "a2", address2);
        append(url, "city", city);
        append(url, "state", state);
        append(url, "postal", postal);
        append(url, "country", country);
        append(url, "apn", apn);
        append(url, "fips", fips);
        append(url, "account", account);
        append(url, "ff", firstInput(source, ["free_form", "freeform", "ff"]));
      } else if (SERVICE === "global-address") {
        url = new URL("https://address.melissadata.net/V3/WEB/GlobalAddress/doGlobalAddress");
        append(url, "a1", address1);
        append(url, "a2", address2);
        append(url, "loc", city);
        append(url, "admarea", state);
        append(url, "postal", postal);
        append(url, "ctry", country);
        append(url, "org", company);
      } else if (SERVICE === "global-name") {
        url = new URL("https://globalname.melissadata.net/V3/WEB/GlobalName/doGlobalName");
        append(url, "full", full);
        append(url, "comp", company);
        append(url, "ctry", country);
      } else if (SERVICE === "global-phone") {
        url = new URL("https://globalphone.melissadata.net/V4/WEB/GlobalPhone/doGlobalPhone");
        append(url, "phone", phone);
        append(url, "ctry", country);
        append(url, "ctryOrg", firstInput(source, ["country_of_origin", "countryorigin"]));
      } else if (SERVICE === "global-email") {
        url = new URL("https://globalemail.melissadata.net/V4/WEB/GlobalEmail/doGlobalEmail");
        append(url, "email", email);
      } else if (SERVICE === "global-ip") {
        url = new URL("https://globalip.melissadata.net/V4/WEB/IPLocation/doIPLocation");
        append(url, "ip", ip);
      } else {
        throw new Error("Unsupported Melissa actor service: " + SERVICE);
      }
      url.searchParams.set("format", "JSON");
      return url;
    };
    const validateInput = (url) => {
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
    };
    const recordsFrom = (payload) => {
      if (Array.isArray(payload)) return payload;
      if (!payload || typeof payload !== "object") return [];
      for (const key of ["Records", "records", "Results", "results", "Matches", "matches", "Properties", "properties"]) {
        if (Array.isArray(payload[key])) return payload[key];
      }
      for (const value of Object.values(payload)) {
        if (Array.isArray(value) && value.every((item) => item && typeof item === "object")) return value;
      }
      return [payload];
    };

    for (let sourceIndex = 0; sourceIndex < selected.length; sourceIndex += 1) {
      const source = selected[sourceIndex];
      const url = buildUrl(source);
      validateInput(url);
      api.progress(sourceIndex / Math.max(selected.length, 1), "Melissa " + SPEC.label + ": " + (source.title || source._id));
      const response = await api.network.fetch({
        url: url.href,
        responseType: "json",
        options: { headers: { accept: "application/json" } }
      });
      if (!response.ok) throw new Error("Melissa " + SPEC.label + " returned HTTP " + response.status);
      const records = recordsFrom(response.body);
      const transmissionResults = findValue(response.body, ["TransmissionResults", "TransmissionResult"]);
      const dataset = source.dataset || "melissa";
      const stamp = new Date().toISOString();

      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        const record = records[recordIndex];
        if (!record || typeof record !== "object") continue;
        const fields = fieldsFrom(record, source, url);
        const kind = primaryKind(record);
        const data = primaryData(kind, fields);
        if (kind === "phone" && !data.number) continue;
        if (kind === "email" && !data.address) continue;
        const stableKey = findValue(record, ["MelissaIdentityKey", "MelissaAddressKey", "AddressKey", "MAK", "MIK", "RecordID", "APN", "ParcelNumber"])
          || titleFor(kind, fields)
          || JSON.stringify(record).slice(0, 1024);
        const suffix = hash(SERVICE + "\\0" + source._id + "\\0" + stableKey + "\\0" + recordIndex);
        const resultId = "starintel:" + kind + ":melissa-" + SERVICE + "-" + suffix;
        const relationId = "starintel:relation:melissa-" + SERVICE + "-" + hash(source._id + "\\0" + resultId);
        const title = titleFor(kind, fields);
        const actorExtension = { actor_id: SPEC.id, input_ids: [source._id], generated: true, service: SERVICE };
        const primaryExtensions = {
          "quasar.actor": actorExtension,
          "melissa.api": {
            service: SERVICE,
            request_url: url.href,
            transmission_results: transmissionResults,
            record
          }
        };
        addDocument(baseDocument(
          resultId,
          dataset,
          kind,
          title,
          data,
          stamp,
          primaryExtensions,
          SPEC.label + " result for " + (source.title || source._id)
        ));
        addDocument(relationDocument(relationId, dataset, source._id, SPEC.predicate, resultId, stamp, { "quasar.actor": actorExtension, "melissa.api": { service: SERVICE, result_id: resultId } }, fields.confidence));

        if (["person", "org"].includes(kind)) {
          for (const related of makeRelatedDocuments(resultId, dataset, fields, stamp, actorExtension)) addDocument(related);
        }
        if (kind === "asset") {
          for (const related of makeRelatedDocuments(resultId, dataset, { ...fields, phone: "", email: "" }, stamp, actorExtension)) addDocument(related);
          if (fields.ownerName) {
            const ownerType = fields.ownerType.toLowerCase();
            const ownerKind = /(company|corporation|business|organization|llc|inc|trust)/.test(ownerType)
              ? "org"
              : /(person|individual|human)/.test(ownerType) ? "person" : "entity";
            const ownerId = "starintel:" + ownerKind + ":melissa-property-owner-" + hash(resultId + "\\0" + fields.ownerName);
            const ownerRelationId = "starintel:relation:melissa-property-owner-" + hash(resultId + "\\0" + ownerId);
            const ownerExtension = { "quasar.actor": actorExtension, "melissa.api": { service: SERVICE, parent_result_id: resultId, owner_type: fields.ownerType } };
            const ownerData = ownerKind === "person"
              ? { name: fields.ownerName, full_name: fields.ownerName, etype: "person", status: "api-result", description: "Property owner returned by Melissa" }
              : ownerKind === "org"
                ? { name: fields.ownerName, display_name: fields.ownerName, etype: "organization", org_type: "property-owner", status: "api-result", description: "Property owner returned by Melissa" }
                : { name: fields.ownerName, display_name: fields.ownerName, etype: "property-owner", status: "api-result", description: "Property owner returned by Melissa" };
            addDocument(baseDocument(ownerId, dataset, ownerKind, fields.ownerName, ownerData, stamp, ownerExtension));
            addDocument(relationDocument(ownerRelationId, dataset, resultId, "owned-by", ownerId, stamp, ownerExtension));
          }
        }
        if (SERVICE === "global-ip" && displayAddress(fields)) {
          for (const related of makeRelatedDocuments(resultId, dataset, { ...fields, phone: "", email: "" }, stamp, actorExtension)) addDocument(related);
        }
      }
    }

    api.progress(1, "Melissa actor complete");
    const resultDocuments = documents.filter((document) => document.dtype !== "relation").length;
    const relations = documents.length - resultDocuments;
    return {
      documents,
      message: "Created " + resultDocuments + " Melissa document(s) and " + relations + " relation(s).",
      metrics: { inputs: selected.length, outputs: documents.length, service: SERVICE }
    };
  }`;
}

export const MELISSA_ACTORS = Object.freeze(
  Object.entries(SERVICES).map(([service, spec]) =>
    Object.freeze({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      version: MELISSA_ACTOR_PACK_VERSION,
      accepts: spec.accepts,
      triggers: [],
      runtime: "quasar.browser-js.v1",
      capabilities: ["network.fetch"],
      limits: {
        timeoutMs: 120_000,
        maxDocuments: 1_024,
        maxOperations: 2_048,
        maxRequests: 64,
        maxResponseBytes: 8 * 1_024 * 1_024,
        maxResultBytes: 32 * 1_024 * 1_024
      },
      minSelection: 1,
      maxSelection: 16,
      source: buildMelissaActorSource(service),
      pack: "melissa",
      service
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

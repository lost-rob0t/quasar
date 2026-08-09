import { useEffect } from "react";

const PROVIDER_BRANDS = Object.freeze({
  openrouter: {
    label: "OpenRouter",
    slug: "openrouter",
    fallback: "OR"
  },
  openai: {
    label: "OpenAI",
    slug: "openai",
    fallback: "OA"
  },
  anthropic: {
    label: "Anthropic",
    slug: "anthropic",
    fallback: "A"
  },
  local: {
    label: "Ollama",
    slug: "ollama",
    fallback: "OL"
  },
  "openai-compatible": {
    label: "OpenAI-compatible API",
    slug: null,
    fallback: "API"
  }
});

const SIMPLE_ICONS_VERSION = "v16";
const GOLD_FILTER =
  "brightness(0) saturate(100%) invert(78%) sepia(54%) saturate(738%) hue-rotate(4deg) brightness(100%) contrast(89%)";

function brandForButton(button) {
  const type = button.querySelector("small")?.textContent?.trim().toLowerCase();
  return type ? { type, ...(PROVIDER_BRANDS[type] || {}) } : null;
}

function makeFallback(text) {
  const fallback = document.createElement("span");
  fallback.textContent = text || "API";
  fallback.style.fontSize = text?.length > 2 ? "0.48rem" : "0.58rem";
  fallback.style.fontWeight = "850";
  fallback.style.letterSpacing = "-0.04em";
  fallback.style.color = "var(--accent)";
  return fallback;
}

function makeBrandIcon(brand) {
  const wrapper = document.createElement("span");
  wrapper.dataset.providerBrandIcon = brand.type;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.title = brand.label || brand.type;
  Object.assign(wrapper.style, {
    display: "grid",
    placeItems: "center",
    flex: "0 0 24px",
    width: "24px",
    height: "24px",
    border: "1px solid color-mix(in srgb, var(--accent) 30%, var(--line))",
    borderRadius: "6px",
    background: "color-mix(in srgb, var(--accent) 8%, var(--surface))"
  });

  const fallback = makeFallback(brand.fallback);
  if (!brand.slug) {
    wrapper.append(fallback);
    return wrapper;
  }

  const image = document.createElement("img");
  image.src = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}/icons/${brand.slug}.svg`;
  image.alt = "";
  image.width = 15;
  image.height = 15;
  image.decoding = "async";
  image.loading = "lazy";
  Object.assign(image.style, {
    width: "15px",
    height: "15px",
    objectFit: "contain",
    filter: GOLD_FILTER
  });
  fallback.hidden = true;
  image.addEventListener(
    "error",
    () => {
      image.hidden = true;
      fallback.hidden = false;
    },
    { once: true }
  );
  wrapper.append(image, fallback);
  return wrapper;
}

function syncProviderIcons() {
  const providerList = document.querySelector(
    '.agent-console[data-tab="providers"] .agent-record-list'
  );
  if (!providerList) return;

  providerList.querySelectorAll(":scope > button").forEach((button) => {
    const brand = brandForButton(button);
    if (!brand) return;
    const current = button.querySelector(":scope > [data-provider-brand-icon]");
    if (current?.dataset.providerBrandIcon === brand.type) return;
    current?.remove();
    button.prepend(makeBrandIcon(brand));
  });
}

export default function ProviderBrandIcons() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncProviderIcons();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    schedule();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}

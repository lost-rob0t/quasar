export type HostedControlPlaneSession = {
  websocketUrl: string;
};

type RuntimeConfig = {
  websocket_url?: unknown;
  login_url?: unknown;
};

const sessionKey = "quasar-hosted-session-authenticated";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Hosted runtime config is missing ${name}.`);
  }
  return value;
}

async function runtimeConfig(): Promise<{ websocketUrl: string; loginUrl: string }> {
  const response = await fetch("/biz/runtime-config", {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) throw new Error("Hosted runtime configuration is unavailable.");
  const config = (await response.json()) as RuntimeConfig;
  return {
    websocketUrl: requireString(config.websocket_url, "websocket_url"),
    loginUrl: requireString(config.login_url, "login_url")
  };
}

function renderLogin(loginUrl: string): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("Quasar root element was not found");

  const shell = document.createElement("main");
  shell.className = "page-card";
  const title = document.createElement("h1");
  title.textContent = "Sign in to Quasar";
  const form = document.createElement("form");
  const username = document.createElement("input");
  username.name = "username";
  username.autocomplete = "username";
  username.placeholder = "Username";
  username.required = true;
  const password = document.createElement("input");
  password.name = "password";
  password.type = "password";
  password.autocomplete = "current-password";
  password.placeholder = "Password";
  password.required = true;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button primary";
  submit.textContent = "Sign in";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  form.append(username, password, submit, status);
  shell.append(title, form);
  root.replaceChildren(shell);

  return new Promise((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "Signing in…";
      try {
        const response = await fetch(loginUrl, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: username.value, password: password.value })
        });
        password.value = "";
        const body = (await response.json()) as {
          message?: unknown;
          workspaces?: unknown;
        };
        if (!response.ok) {
          throw new Error(typeof body.message === "string" ? body.message : "Sign-in failed.");
        }
        if (
          !Array.isArray(body.workspaces) ||
          typeof body.workspaces[0] !== "string" ||
          body.workspaces[0] === ""
        ) {
          throw new Error("Sign-in did not grant a Quasar workspace.");
        }
        sessionStorage.setItem("quasar-workspace", body.workspaces[0]);
        sessionStorage.setItem(sessionKey, "1");
        resolve();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Sign-in failed.";
        submit.disabled = false;
      }
    });
  });
}

export async function prepareHostedControlPlane(): Promise<HostedControlPlaneSession | null> {
  if (!import.meta.env.PROD) return null;
  const config = await runtimeConfig();
  if (sessionStorage.getItem(sessionKey) !== "1") await renderLogin(config.loginUrl);
  return { websocketUrl: config.websocketUrl };
}

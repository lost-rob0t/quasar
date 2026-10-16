// Component journey fixture. The production ActorManager and HTTP client run unchanged;
// the Quasar shell/store and StarIntel runtime are not part of this fixture.
import React from "react";
import { createRoot } from "react-dom/client";
import ActorManager from "../../../src/components/ActorManager";
import "../../../src/styles.css";
createRoot(document.getElementById("root")).render(<ActorManager />);

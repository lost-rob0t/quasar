import { createRoot } from "react-dom/client";
import CodeWorkbench from "../../../src/components/CodeWorkbench";
import "../../../src/styles.css";
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 16, minWidth: 0 }}>
    <CodeWorkbench />
  </main>
);

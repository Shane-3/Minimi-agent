import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing the #root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

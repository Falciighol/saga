import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function render() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Outside Tauri (plain `npm run dev` in a browser) fake the backend so the UI still works.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  import("./dev/mockBackend").then((m) => {
    m.installMockBackend();
    render();
  });
} else {
  render();
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayMenu } from "./TrayMenu";
import "./index.css";

const isTrayView = new URLSearchParams(window.location.search).get("view") === "tray";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isTrayView ? <TrayMenu /> : <App />}
  </React.StrictMode>,
);

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import SessionsView from "./SessionsView";
import SessionView from "./SessionView";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<SessionsView />} />
          <Route path="session/:id" element={<SessionView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);

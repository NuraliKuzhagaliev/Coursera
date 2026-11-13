import React from "react";
import { createRoot } from "react-dom/client";
import { AccountPanel } from "./Account";
const root = document.getElementById("license-root");
if (root) createRoot(root).render(<AccountPanel send={message => chrome.runtime.sendMessage(message)} />);

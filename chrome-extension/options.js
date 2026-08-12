import { loadDashboardUrl, saveDashboardUrl } from "./dashboard-config.js";

const form = document.querySelector("#options-form");
const input = document.querySelector("#dashboard-url");
const status = document.querySelector("#status");
const button = form.querySelector("button");

input.value = await loadDashboardUrl() ?? "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = "Requesting access";
  try {
    input.value = await saveDashboardUrl(input.value);
    status.textContent = "Saved";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not save dashboard";
  } finally {
    button.disabled = false;
  }
});

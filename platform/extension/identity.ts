// Self-contained because Chrome serializes this function into an isolated world.
export function readIdentityFields() {
  if (!["www.coursera.org", "coursera.org"].includes(location.hostname) || location.pathname !== "/account-settings") return null;
  const inputs = [...document.querySelectorAll<HTMLInputElement>("input")].filter(node => node.getClientRects().length && node.type !== "password");
  const descriptions = (node: HTMLInputElement) => [
    ...[...(node.labels || [])].map(label => label.textContent || ""),
    node.getAttribute("aria-label") || "",
    ...(node.getAttribute("aria-labelledby") || "").split(" ").map(id => document.getElementById(id)?.textContent || "")
  ].map(value => value.trim().replace(/\s+/g, " "));
  const names = inputs.filter(node => descriptions(node).some(value =>
    /^(?:full name|полное имя|имя и фамилия)\s*\*?$/i.test(value)) || node.autocomplete === "name");
  const emails = inputs.filter(node => descriptions(node).some(value =>
    /^(?:email address|email|электронная почта|адрес электронной почты)\s*\*?$/i.test(value)) || node.type === "email");
  if (names.length !== 1 || emails.length !== 1) return null;
  const name = names[0].value.trim(), email = emails[0].value.trim();
  return name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { name, email } : null;
}

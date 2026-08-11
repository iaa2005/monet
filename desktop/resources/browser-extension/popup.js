/** The only way a tab becomes drivable: a person, on the tab, pressing this. */

const $ = (id) => document.getElementById(id);
let current = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refresh() {
  const s = (await ask({ type: "status" })) || {};
  const tab = await activeTab();
  current = tab;

  $("dot").className = `dot${s.connected ? " on" : ""}`;
  $("status").textContent = !s.paired
    ? "Not paired yet"
    : s.connected
      ? "Connected to Code Monet"
      : "Waiting for Code Monet…";
  $("pairing").style.display = s.paired ? "none" : "";

  const attachedHere = tab && s.attachedTabId === tab.id;
  $("toggle").textContent = attachedHere
    ? "Detach this tab"
    : s.attachedTabId != null
      ? "Attach this tab instead"
      : "Attach this tab";
  $("toggle").className = attachedHere ? "" : "primary";
  $("tab").textContent =
    s.attachedTabId == null
      ? "No tab attached."
      : attachedHere
        ? `Driving: ${tab.title || tab.url || ""}`
        : "Another tab is attached.";
}

$("pair").addEventListener("click", async () => {
  const token = $("token").value.trim().toUpperCase();
  if (!token) return;
  await ask({ type: "pair", token });
  setTimeout(refresh, 400);
});

$("toggle").addEventListener("click", async () => {
  const s = (await ask({ type: "status" })) || {};
  if (current && s.attachedTabId === current.id) await ask({ type: "detach" });
  else if (current) await ask({ type: "attach", tabId: current.id });
  setTimeout(refresh, 300);
});

refresh();
setInterval(refresh, 1500);

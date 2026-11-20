"use strict";

// Temporary feedback destination. Replace before publishing the extension.
const FEEDBACK_EMAIL = "example@gmail.com";
const MAX_UNINSTALL_URL = 1023;

const status = document.getElementById("status");

function makeGmailDraftUrl(reasons, rawComment) {
  const subject = "Website Page Auditor feedback";
  let comment = Array.from(rawComment.trim());
  let url = "";
  do {
    const body = [
      "Website Page Auditor exit feedback",
      `Reasons: ${reasons.length ? reasons.join(", ") : "No reason selected"}`,
      comment.length ? `Comment: ${comment.join("")}` : "",
    ].filter(Boolean).join("\n");
    url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(FEEDBACK_EMAIL)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (url.length <= MAX_UNINSTALL_URL || comment.length === 0) break;
    comment.pop();
  } while (true);
  return url;
}

async function uninstall(uninstallUrl) {
  status.textContent = "Chrome will ask you to confirm removal. Cancel the prompt to keep the extension.";
  try {
    await chrome.runtime.setUninstallURL(uninstallUrl);
    await chrome.management.uninstallSelf({ showConfirmDialog: true });
  } catch (error) {
    await chrome.runtime.setUninstallURL("").catch(() => {});
    status.textContent = "The extension was not removed. You can change your answers and try again.";
  }
}

document.getElementById("leaveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const reasons = [...document.querySelectorAll('input[name="reason"]:checked')].map((input) => input.value);
  const gmailUrl = makeGmailDraftUrl(reasons, document.getElementById("comment").value);
  await uninstall(gmailUrl);
});

document.getElementById("uninstallWithoutFeedback").addEventListener("click", () => uninstall(""));

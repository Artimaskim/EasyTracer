// This script runs in the background, listening for browser events.

// Listen for when the user clicks on the extension's icon.
chrome.action.onClicked.addListener((tab) => {
  // When clicked, open the side panel.
  chrome.sidePanel.open({ windowId: tab.windowId });
});

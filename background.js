console.log("Chrome internal redirect URI:", chrome.identity.getRedirectURL());
let cachedToken = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "auth") {
    getToken()
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep message channel open
  }
});

function getToken() {
  if (cachedToken) {
    console.log("Using cached token");
    return Promise.resolve(cachedToken);
  }

  return new Promise((resolve, reject) => {
    const redirectUri = chrome.identity.getRedirectURL();
    const clientId = "1048045525974-eoku0strjgc79fe71ah6pp12ak7lgv1m.apps.googleusercontent.com";
    const scope = "https://mail.google.com/";

    console.log("Using client ID:", chrome.runtime.getManifest().oauth2.client_id);
    const authUrl =
      `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}` +
      `&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scope)}&prompt=consent`;

    console.log("Launching auth flow with URL:", authUrl);
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, redirectUrl => {
      console.log("Auth flow completed with redirect URL:", redirectUrl);

      if (chrome.runtime.lastError || !redirectUrl) return reject(new Error("OAuth failed"));

      const params = new URLSearchParams(redirectUrl.split("#")[1]);
      const token = params.get("access_token");

      if (!token) return reject(new Error("No access token found"));
      console.log("Extracted access token:", token);

      cachedToken = token; // cache for session
      resolve(token);
    });
  });
}
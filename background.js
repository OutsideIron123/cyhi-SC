chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "classify_content") {
    fetch("http://localhost:8000/classify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: request.text,
        image: request.imageURL
      })
    })
    .then(response => response.json())
    .then(data => {
 
      sendResponse({ success: true, isToxic: (data.toxic > 0.8), isNSFW: data.nsfw });
    })
    .catch(error => {
      console.error("Local model is not running or encountered an error:", error);
      sendResponse({ success: false });
    });

   
    return true; 
  }
});
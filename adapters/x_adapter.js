const processedTweets = new Set();

function hideTweet(tweetNode, reason) {
  tweetNode.style.filter = "blur(15px)";
  tweetNode.style.pointerEvents = "none";
  tweetNode.style.transition = "filter 0.3s ease";
  
  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '999';
  overlay.style.pointerEvents = 'auto'; 
  
  const button = document.createElement('button');
  button.innerText = `Hidden: ${reason}. Click to reveal.`;
  button.style.padding = '10px 20px';
  button.style.backgroundColor = '#ff4a4a';
  button.style.color = 'white';
  button.style.border = 'none';
  button.style.borderRadius = '5px';
  button.style.cursor = 'pointer';
  
  button.addEventListener('click', () => {
    tweetNode.style.filter = "none";
    tweetNode.style.pointerEvents = "auto";
    overlay.remove();
  });
  
  overlay.appendChild(button);
  
  if (getComputedStyle(tweetNode).position === 'static') {
      tweetNode.style.position = 'relative';
  }
  tweetNode.appendChild(overlay);
}

function processTweet(tweetNode) {
  const timeLink = tweetNode.querySelector('time')?.closest('a');
  const tweetId = timeLink ? timeLink.href : tweetNode.innerText.slice(0, 50);

  if (processedTweets.has(tweetId)) return;
  processedTweets.add(tweetId);

  const textEl = tweetNode.querySelector('[data-testid="tweetText"]');
  const imgEl = tweetNode.querySelector('[data-testid="tweetPhoto"] img');
  
  const textContent = textEl ? textEl.innerText : "";
  const imageUrl = imgEl ? imgEl.src : null;

  if (!textContent && !imageUrl) return;

  chrome.runtime.sendMessage(
    { action: "classify_content", text: textContent, imageURL: imageUrl },
    (response) => {
      if (response && response.success) {
        if (response.isToxic) hideTweet(tweetNode, "Toxicity Flagged");
        else if (response.isNSFW) hideTweet(tweetNode, "NSFW Flagged");
      }
    }
  );
}

const observer = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === 1) { 
        if (node.matches && node.matches('article[data-testid="tweet"]')) {
          processTweet(node);
        } else if (node.querySelectorAll) {
          const tweets = node.querySelectorAll('article[data-testid="tweet"]');
          tweets.forEach(processTweet);
        }
      }
    });
  });
});

observer.observe(document.body, { childList: true, subtree: true });
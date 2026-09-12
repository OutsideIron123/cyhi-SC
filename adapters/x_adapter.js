const processedTweets = new Set();

function hideTweet(tweetNode, reason) {
  if (tweetNode.querySelector('.zenlayer-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'zenlayer-overlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '999';
  overlay.style.backdropFilter = 'blur(16px)';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
  overlay.style.borderRadius = 'inherit';
  
  const button = document.createElement('button');
  button.innerText = `Hidden: ${reason}. Click to reveal.`;
  button.style.padding = '10px 18px';
  button.style.backgroundColor = '#e02424';
  button.style.color = '#ffffff';
  button.style.fontWeight = '600';
  button.style.border = 'none';
  button.style.borderRadius = '6px';
  button.style.cursor = 'pointer';
  button.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  
  button.addEventListener('click', (e) => {
    e.stopPropagation();
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
  const textEl = tweetNode.querySelector('[data-testid="tweetText"]');
  const imgEl = tweetNode.querySelector('[data-testid="tweetPhoto"] img');
  
  const textContent = textEl ? textEl.innerText : "";
  const imageUrl = imgEl ? imgEl.src : null;

  const tweetId = timeLink ? timeLink.href : (textContent.slice(0, 50) || imageUrl);
  if (!tweetId || processedTweets.has(tweetId)) return;
  processedTweets.add(tweetId);

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
document.querySelectorAll('article[data-testid="tweet"]').forEach(processTweet);
const processedPosts = new Set();

function hideInstaPost(postNode, reason) {
  if (postNode.querySelector('.zenlayer-overlay')) return;

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
  
  if (getComputedStyle(postNode).position === 'static') {
    postNode.style.position = 'relative';
  }
  postNode.appendChild(overlay);
}

function processInstaPost(postNode) {
  const imgEl = postNode.querySelector('img[style*="object-fit"]') || postNode.querySelector('img[crossorigin]');
  const imageUrl = imgEl ? imgEl.src : null;

  const h1El = postNode.querySelector('h1');
  const captionText = h1El ? h1El.innerText : postNode.innerText.slice(0, 200);

  const timeEl = postNode.querySelector('time');
  const postLink = timeEl ? timeEl.closest('a') : null;
  const postId = postLink?.href || imageUrl || captionText.slice(0, 40) || null;

  if (!postId || processedPosts.has(postId)) return;
  processedPosts.add(postId);

  if (!captionText && !imageUrl) return;

  chrome.runtime.sendMessage(
    { action: "classify_content", text: captionText, imageURL: imageUrl },
    (response) => {
      if (response && response.success) {
        if (response.isToxic) hideInstaPost(postNode, "Toxicity Flagged");
        else if (response.isNSFW) hideInstaPost(postNode, "NSFW Flagged");
      }
    }
  );
}

const instaObserver = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === 1) {
        if (node.tagName && node.tagName.toLowerCase() === 'article') {
          processInstaPost(node);
        } else if (node.querySelectorAll) {
          const articles = node.querySelectorAll('article');
          articles.forEach(processInstaPost);
        }
      }
    });
  });
});

instaObserver.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('article').forEach(processInstaPost);
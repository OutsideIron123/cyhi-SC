const processedPosts = new Set();

function hidePost(postNode, reason) {
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

function processRedditPost(postNode) {
  const postId = postNode.getAttribute('id');
  if (!postId || processedPosts.has(postId)) return;
  processedPosts.add(postId);

  const titleText = postNode.getAttribute('post-title') || "";
  const bodyTextEl = postNode.querySelector('div[slot="text-body"]');
  const bodyText = bodyTextEl ? bodyTextEl.innerText : "";
  const fullText = `${titleText} ${bodyText}`.trim();
  
  const imgEl = postNode.querySelector('img.preview');
  const imageUrl = imgEl ? imgEl.src : null;

  if (!fullText && !imageUrl) return;

  chrome.runtime.sendMessage(
    { action: "classify_content", text: fullText, imageURL: imageUrl },
    (response) => {
      if (response && response.success) {
        if (response.isToxic) hidePost(postNode, "Toxicity Flagged");
        else if (response.isNSFW) hidePost(postNode, "NSFW Flagged");
      }
    }
  );
}

const redditObserver = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === 1) {
        if (node.tagName && node.tagName.toLowerCase() === 'shreddit-post') {
          processRedditPost(node);
        } else if (node.querySelectorAll) {
          const posts = node.querySelectorAll('shreddit-post');
          posts.forEach(processRedditPost);
        }
      }
    });
  });
});

redditObserver.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('shreddit-post').forEach(processRedditPost);
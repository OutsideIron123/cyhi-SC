const processedPosts = new Set();

function hideInstaPost(postNode, reason) {
  postNode.style.filter = "blur(20px)";
  postNode.style.pointerEvents = "none";
  postNode.style.transition = "filter 0.3s ease";
  
  const overlay = document.createElement('div');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
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
    postNode.style.filter = "none";
    postNode.style.pointerEvents = "auto";
    overlay.remove();
  });
  
  overlay.appendChild(button);
  
  if (getComputedStyle(postNode).position === 'static') {
      postNode.style.position = 'relative';
  }
  postNode.appendChild(overlay);
}

function processInstaPost(postNode) {
  const timeEl = postNode.querySelector('time');
  const postLink = timeEl ? timeEl.closest('a') : null;
  const postId = postLink ? postLink.href : null;

  if (!postId || processedPosts.has(postId)) return;
  processedPosts.add(postId);

  const imgEl = postNode.querySelector('img[style*="object-fit"]') || postNode.querySelector('img[crossorigin]');
  const imageUrl = imgEl ? imgEl.src : null;

  const h1El = postNode.querySelector('h1');
  let captionText = "";
  if (h1El) {
    captionText = h1El.innerText;
  } else {
    captionText = postNode.innerText.slice(0, 200); 
  }

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
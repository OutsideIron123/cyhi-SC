const processedPosts = new Set();

function hideLinkedInPost(postNode, reason) {
  if (postNode.querySelector('.zenlayer-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'zenlayer-overlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = '99';
  overlay.style.backdropFilter = 'blur(16px)';
  overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
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

function processLinkedInPost(postNode) {
  const postId = postNode.getAttribute('data-urn') || postNode.getAttribute('data-id');
  if (!postId || processedPosts.has(postId)) return;
  processedPosts.add(postId);

  const textEl = postNode.querySelector('.update-components-text, .feed-shared-update-v2__description');
  const textContent = textEl ? textEl.innerText.trim() : "";

  const imgEl = postNode.querySelector('.update-components-image__image, .feed-shared-image__image');
  const imageUrl = imgEl ? imgEl.src : null;

  if (!textContent && !imageUrl) return;

  chrome.runtime.sendMessage(
    { action: "classify_content", text: textContent, imageURL: imageUrl },
    (response) => {
      if (response && response.success) {
        if (response.isToxic) hideLinkedInPost(postNode, "Boasting / Noise Detected");
        else if (response.isNSFW) hideLinkedInPost(postNode, "NSFW Flagged");
      }
    }
  );
}

const linkedInObserver = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === 1) {
        if (node.hasAttribute && node.hasAttribute('data-urn')) {
          processLinkedInPost(node);
        } else if (node.querySelectorAll) {
          const posts = node.querySelectorAll('div[data-urn]');
          posts.forEach(processLinkedInPost);
        }
      }
    });
  });
});

linkedInObserver.observe(document.body, { childList: true, subtree: true });

document.querySelectorAll('div[data-urn]').forEach(processLinkedInPost);
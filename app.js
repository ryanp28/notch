import { auth, db } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, collection,
  query, where, onSnapshot, getDocs, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SENTIMENT_RANGES = {
  loved: { min: 7.0, max: 10.0 },
  fine: { min: 4.0, max: 6.9 },
  disliked: { min: 0.0, max: 3.9 }
};
const CATEGORIES = ['City', 'Landmark', 'Nature', 'Food & Drink', 'Lodging', 'Activity'];
const MAX_PHOTOS = 3;
const LINK_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', urlPrefix: 'https://instagram.com/' },
  { key: 'tiktok', label: 'TikTok', urlPrefix: 'https://tiktok.com/@' },
  { key: 'twitter', label: 'X', urlPrefix: 'https://x.com/' },
  { key: 'website', label: 'Website', urlPrefix: '' }
];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let currentUser = null;
let unsubscribeDestinations = null;
const emptyProfile = () => ({ name: '', bio: '', photoURL: '', links: {}, followers: 0, following: 0 });
let state = { destinations: [], wantToVisit: [], profile: emptyProfile() };

// ---------- AUTH SCREEN ----------
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('authForm-login').classList.toggle('hidden', btn.dataset.authtab !== 'login');
    document.getElementById('authForm-signup').classList.toggle('hidden', btn.dataset.authtab !== 'signup');
    hideAuthError();
  });
});

function showAuthError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAuthError() {
  document.getElementById('authError').classList.add('hidden');
}

document.getElementById('signupBtn').addEventListener('click', async () => {
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  if (!name || !email || !password) { showAuthError('Please fill in all fields.'); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, 'users', cred.user.uid), {
      name, nameLower: name.toLowerCase(), email, createdAt: serverTimestamp()
    });
  } catch (err) {
    showAuthError(err.message.replace('Firebase: ', ''));
  }
});

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) { showAuthError('Please enter email and password.'); return; }
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    showAuthError(err.message.replace('Firebase: ', ''));
  }
});

document.getElementById('signOutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    const data = userDoc.exists() ? userDoc.data() : {};
    state.profile.name = data.name || user.displayName || '';
    state.profile.bio = data.bio || '';
    state.profile.photoURL = data.photoURL || '';
    state.profile.links = data.links || {};
    attachDestinationsListener();
    refreshFollowCounts();
    switchTab('feed');
  } else {
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
    if (unsubscribeDestinations) { unsubscribeDestinations(); unsubscribeDestinations = null; }
    state = { destinations: [], wantToVisit: [], profile: emptyProfile() };
  }
});

// ---------- LIVE DESTINATIONS LISTENER ----------
function attachDestinationsListener() {
  const q = query(collection(db, 'destinations'), where('ownerId', '==', currentUser.uid));
  unsubscribeDestinations = onSnapshot(q, (snapshot) => {
    const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    state.destinations = all.filter(d => d.status === 'ranked');
    state.wantToVisit = all.filter(d => d.status === 'want');
    const activeTab = document.querySelector('.tab-panel.active').id;
    if (activeTab === 'tab-rankings') renderRankings();
    if (activeTab === 'tab-want') renderWantList();
    if (activeTab === 'tab-profile') renderProfile();
  });
}

// ---------- NAVIGATION ----------
const tabButtons = document.querySelectorAll('.nav-btn[data-tab]');
const tabPanels = document.querySelectorAll('.tab-panel');

function switchTab(tabName) {
  tabPanels.forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tabName).classList.add('active');
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  if (tabName === 'rankings') renderRankings();
  if (tabName === 'want') renderWantList();
  if (tabName === 'profile') renderProfile();
  if (tabName === 'feed') renderFeed();
}
tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
document.getElementById('openAddBtn').addEventListener('click', openAddModal);
document.getElementById('profileBtn').addEventListener('click', () => switchTab('profile'));

// ---------- SCORE HELPERS ----------
function scoreClass(score) {
  if (score >= 8) return 'score-high';
  if (score >= 5) return 'score-mid';
  return 'score-low';
}
function formatScore(score) { return score.toFixed(1); }

// ---------- IMAGE COMPRESSION ----------
function compressImage(file, maxWidth = 800) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- RENDER: FEED ----------
async function renderFeed() {
  const list = document.getElementById('feedList');
  const hint = document.getElementById('feedHint');
  list.innerHTML = '';

  const followsSnap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', currentUser.uid)));
  const followingIds = followsSnap.docs.map(d => d.data().followingId);

  if (followingIds.length === 0) {
    hint.classList.remove('hidden');
    return;
  }
  hint.classList.add('hidden');

  let items = [];
  for (let i = 0; i < followingIds.length; i += 10) {
    const chunk = followingIds.slice(i, i + 10);
    const snap = await getDocs(query(collection(db, 'destinations'), where('ownerId', 'in', chunk), limit(50)));
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.status === 'ranked') items.push({ id: d.id, ...data });
    });
  }
  items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  items = items.slice(0, 25);

  if (items.length === 0) {
    hint.textContent = "Your friends haven't ranked anything yet.";
    hint.classList.remove('hidden');
    return;
  }

  items.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.style.setProperty('--i', idx);
    const initials = (item.ownerName || '?').charAt(0).toUpperCase();
    const photo = item.photos && item.photos[0] ? item.photos[0] : '';
    card.innerHTML = `
      <div class="feed-user-row feed-user-row-clickable">
        <div class="feed-avatar">${escapeHtml(initials)}</div>
        <div>
          <div class="feed-username">${escapeHtml(item.ownerName || 'Someone')}</div>
          <div class="feed-action">ranked a new destination</div>
        </div>
      </div>
      ${photo ? `<div class="feed-photo" style="background-image:url('${photo}')"></div>` : ''}
      <div class="feed-caption"><strong>${escapeHtml(item.name)}</strong> · ${escapeHtml(item.category)} · Score ${formatScore(item.score)}</div>
      <div class="feed-social-row">
        <button class="cheer-btn" data-id="${item.id}">🤍 <span class="cheer-count">0</span></button>
        <span class="comment-count-label" data-id="${item.id}">0 comments</span>
      </div>
      <div class="comment-list" data-id="${item.id}"></div>
      <div class="comment-input-row">
        <input class="text-input comment-input" data-id="${item.id}" placeholder="Add a comment..." />
      </div>
    `;
    card.querySelector('.feed-user-row-clickable').addEventListener('click', () => openViewProfile(item.ownerId));
    list.appendChild(card);
    attachSocialControls(card, item.id);
  });
}

// ---------- FEED: REACTIONS & COMMENTS ----------
async function attachSocialControls(card, destId) {
  const cheerBtn = card.querySelector('.cheer-btn');
  const commentListEl = card.querySelector('.comment-list');
  const commentCountLabel = card.querySelector('.comment-count-label');
  const commentInput = card.querySelector('.comment-input');

  const reactionsSnap = await getDocs(query(collection(db, 'reactions'), where('destinationId', '==', destId)));
  const myReactionId = `${destId}_${currentUser.uid}`;
  const iAlreadyCheered = reactionsSnap.docs.some(d => d.id === myReactionId);
  cheerBtn.classList.toggle('cheered', iAlreadyCheered);
  cheerBtn.innerHTML = `${iAlreadyCheered ? '❤️' : '🤍'} <span class="cheer-count">${reactionsSnap.size}</span>`;

  cheerBtn.addEventListener('click', async () => {
    const reactionRef = doc(db, 'reactions', myReactionId);
    const currentlyCheered = cheerBtn.classList.contains('cheered');
    if (currentlyCheered) {
      await deleteDoc(reactionRef);
      cheerBtn.classList.remove('cheered');
    } else {
      await setDoc(reactionRef, { destinationId: destId, userId: currentUser.uid, createdAt: serverTimestamp() });
      cheerBtn.classList.add('cheered');
    }
    const freshSnap = await getDocs(query(collection(db, 'reactions'), where('destinationId', '==', destId)));
    cheerBtn.innerHTML = `${cheerBtn.classList.contains('cheered') ? '❤️' : '🤍'} <span class="cheer-count">${freshSnap.size}</span>`;
  });

  async function loadComments() {
    const commentsSnap = await getDocs(query(collection(db, 'comments'), where('destinationId', '==', destId)));
    const comments = commentsSnap.docs.map(d => d.data()).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    commentCountLabel.textContent = comments.length === 1 ? '1 comment' : `${comments.length} comments`;
    commentListEl.innerHTML = comments.map(c => `
      <div class="comment-item"><strong>${escapeHtml(c.authorName)}</strong> ${escapeHtml(c.text)}</div>
    `).join('');
  }
  loadComments();

  commentInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = commentInput.value.trim();
    if (!text) return;
    commentInput.value = '';
    await addDoc(collection(db, 'comments'), {
      destinationId: destId,
      authorId: currentUser.uid,
      authorName: state.profile.name || currentUser.email,
      text,
      createdAt: serverTimestamp()
    });
    loadComments();
  });
}

// ---------- RENDER: RANKINGS ----------
let activeCategoryFilter = 'All';

function renderCategoryFilters() {
  const row = document.getElementById('categoryFilters');
  row.innerHTML = '';
  ['All', ...CATEGORIES].forEach(cat => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (activeCategoryFilter === cat ? ' active' : '');
    chip.textContent = cat;
    chip.addEventListener('click', () => { activeCategoryFilter = cat; renderRankings(); });
    row.appendChild(chip);
  });
}

let rankingsViewMode = 'list';
document.getElementById('showListViewChip').addEventListener('click', () => {
  rankingsViewMode = 'list';
  document.getElementById('showListViewChip').classList.add('active');
  document.getElementById('showMapViewChip').classList.remove('active');
  renderRankings();
});
document.getElementById('showMapViewChip').addEventListener('click', () => {
  rankingsViewMode = 'map';
  document.getElementById('showMapViewChip').classList.add('active');
  document.getElementById('showListViewChip').classList.remove('active');
  renderRankings();
});

function renderRankings() {
  renderCategoryFilters();
  const list = document.getElementById('rankingsList');
  const empty = document.getElementById('rankingsEmpty');
  const mapContainer = document.getElementById('mapContainer');
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();

  let items = [...state.destinations];
  if (activeCategoryFilter !== 'All') items = items.filter(d => d.category === activeCategoryFilter);
  if (searchTerm) items = items.filter(d => d.name.toLowerCase().includes(searchTerm));
  items.sort((a, b) => b.score - a.score);

  if (rankingsViewMode === 'map') {
    list.classList.add('hidden');
    mapContainer.classList.remove('hidden');
    empty.classList.add('hidden');
    renderMapView(items);
    return;
  }
  mapContainer.classList.add('hidden');
  list.classList.remove('hidden');

  list.innerHTML = '';
  empty.classList.toggle('hidden', items.length > 0 || state.destinations.length > 0);
  if (state.destinations.length === 0) return;

  items.forEach((dest, idx) => {
    const card = document.createElement('button');
    card.className = 'dest-card';
    card.style.setProperty('--i', idx);
    const cover = dest.photos && dest.photos[0] ? `style="background-image:url('${dest.photos[0]}')"` : '';
    card.innerHTML = `
      <div class="dest-card-photo" ${cover}>${dest.photos && dest.photos[0] ? '' : '📍'}</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row">
          <span class="dest-card-name">${escapeHtml(dest.name)}</span>
          <span class="score-badge ${scoreClass(dest.score)}">${formatScore(dest.score)}</span>
        </div>
        <span class="dest-card-meta">${escapeHtml(dest.category)} · ${escapeHtml(dest.location || 'No location')}</span>
        <span class="rank-badge">#${idx + 1} in ${escapeHtml(dest.category)}</span>
      </div>
    `;
    card.addEventListener('click', () => openDetailModal(dest.id, false));
    list.appendChild(card);
  });
}
document.getElementById('searchInput').addEventListener('input', renderRankings);

// ---------- MAP VIEW ----------
let leafletMap = null;
let leafletMarkersLayer = null;

function renderMapView(items) {
  const withCoords = items.filter(d => typeof d.lat === 'number' && typeof d.lon === 'number');
  const mapEmpty = document.getElementById('mapEmpty');
  mapEmpty.classList.toggle('hidden', withCoords.length > 0);
  if (withCoords.length === 0) return;

  if (!leafletMap) {
    leafletMap = L.map('mapContainer');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(leafletMap);
    leafletMarkersLayer = L.layerGroup().addTo(leafletMap);
  } else {
    leafletMarkersLayer.clearLayers();
  }

  const scoreColor = (score) => score >= 8 ? '#2e7d4f' : score >= 5 ? '#d4a437' : '#c0392b';

  withCoords.forEach(dest => {
    const marker = L.circleMarker([dest.lat, dest.lon], {
      radius: 9,
      color: '#ffffff',
      weight: 2,
      fillColor: scoreColor(dest.score),
      fillOpacity: 1
    });
    marker.bindPopup(`
      <span class="map-popup-score" style="background:${scoreColor(dest.score)}">${formatScore(dest.score)}</span>
      <strong>${escapeHtml(dest.name)}</strong><br/>${escapeHtml(dest.category)}
    `);
    marker.addTo(leafletMarkersLayer);
  });

  const bounds = L.latLngBounds(withCoords.map(d => [d.lat, d.lon]));
  setTimeout(() => {
    leafletMap.invalidateSize();
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  }, 50);
}

// ---------- RENDER: WANT TO VISIT ----------
function renderWantList() {
  const list = document.getElementById('wantList');
  const empty = document.getElementById('wantEmpty');
  list.innerHTML = '';
  empty.classList.toggle('hidden', state.wantToVisit.length > 0);
  state.wantToVisit.forEach((dest, idx) => {
    const card = document.createElement('button');
    card.className = 'dest-card';
    card.style.setProperty('--i', idx);
    const cover = dest.photos && dest.photos[0] ? `style="background-image:url('${dest.photos[0]}')"` : '';
    card.innerHTML = `
      <div class="dest-card-photo" ${cover}>${dest.photos && dest.photos[0] ? '' : '🔖'}</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row"><span class="dest-card-name">${escapeHtml(dest.name)}</span></div>
        <span class="dest-card-meta">${escapeHtml(dest.category)} · ${escapeHtml(dest.location || 'No location')}</span>
      </div>
    `;
    card.addEventListener('click', () => openDetailModal(dest.id, true));
    list.appendChild(card);
  });
}

// ---------- RENDER: PROFILE ----------
async function refreshFollowCounts() {
  const followingSnap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', currentUser.uid)));
  const followersSnap = await getDocs(query(collection(db, 'follows'), where('followingId', '==', currentUser.uid)));
  state.profile.following = followingSnap.size;
  state.profile.followers = followersSnap.size;
}

function buildLinksHtml(links) {
  if (!links) return '';
  return LINK_PLATFORMS
    .filter(p => links[p.key])
    .map(p => {
      const value = links[p.key];
      const url = p.urlPrefix ? p.urlPrefix + value.replace(/^@/, '') : (value.startsWith('http') ? value : 'https://' + value);
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${p.label}</a>`;
    })
    .join('');
}

function renderAvatar(imgEl, fallbackEl, photoURL, name) {
  if (photoURL) {
    imgEl.src = photoURL;
    imgEl.classList.remove('hidden');
    fallbackEl.classList.add('hidden');
  } else {
    imgEl.classList.add('hidden');
    fallbackEl.classList.remove('hidden');
    fallbackEl.textContent = (name || '?').charAt(0).toUpperCase();
  }
}

async function renderProfile() {
  renderAvatar(
    document.getElementById('profileAvatarImg'),
    document.getElementById('profileAvatarFallback'),
    state.profile.photoURL,
    state.profile.name
  );
  document.getElementById('profileDisplayName').textContent = state.profile.name || currentUser.email;
  document.getElementById('profileBioDisplay').textContent = state.profile.bio || '';
  document.getElementById('profileLinksRow').innerHTML = buildLinksHtml(state.profile.links);

  const dests = state.destinations;
  document.getElementById('statTotal').textContent = dests.length;
  const avg = dests.length ? (dests.reduce((s, d) => s + d.score, 0) / dests.length) : 0;
  document.getElementById('statAvg').textContent = avg.toFixed(1);

  await refreshFollowCounts();
  document.getElementById('statFollowers').textContent = state.profile.followers;
  document.getElementById('statFollowing').textContent = state.profile.following;

  const catStatsEl = document.getElementById('categoryStats');
  catStatsEl.innerHTML = '';
  CATEGORIES.forEach(cat => {
    const items = dests.filter(d => d.category === cat);
    if (items.length === 0) return;
    const row = document.createElement('div');
    row.className = 'category-stat-row';
    row.innerHTML = `<span>${escapeHtml(cat)}</span><span>${items.length} ranked</span>`;
    catStatsEl.appendChild(row);
  });

  renderFriendsList();
}

// ---------- EDIT PROFILE MODAL ----------
const editProfileModal = document.getElementById('editProfileModal');
let editAvatarDataUrl = null;

document.getElementById('editProfileBtn').addEventListener('click', () => {
  document.getElementById('editNameInput').value = state.profile.name || '';
  document.getElementById('editBioInput').value = state.profile.bio || '';
  document.getElementById('editInstagramInput').value = state.profile.links?.instagram || '';
  document.getElementById('editTiktokInput').value = state.profile.links?.tiktok || '';
  document.getElementById('editTwitterInput').value = state.profile.links?.twitter || '';
  document.getElementById('editWebsiteInput').value = state.profile.links?.website || '';
  editAvatarDataUrl = state.profile.photoURL || null;
  const previewImg = document.getElementById('editAvatarPreview');
  if (state.profile.photoURL) previewImg.src = state.profile.photoURL;
  else previewImg.removeAttribute('src');
  editProfileModal.classList.remove('hidden');
});
document.getElementById('closeEditProfileModal').addEventListener('click', () => editProfileModal.classList.add('hidden'));

document.getElementById('editAvatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  editAvatarDataUrl = await compressImage(file, 400);
  document.getElementById('editAvatarPreview').src = editAvatarDataUrl;
});

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  const name = document.getElementById('editNameInput').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  const bio = document.getElementById('editBioInput').value.trim();
  const links = {
    instagram: document.getElementById('editInstagramInput').value.trim(),
    tiktok: document.getElementById('editTiktokInput').value.trim(),
    twitter: document.getElementById('editTwitterInput').value.trim(),
    website: document.getElementById('editWebsiteInput').value.trim()
  };
  Object.keys(links).forEach(k => { if (!links[k]) delete links[k]; });

  await setDoc(doc(db, 'users', currentUser.uid), {
    name, nameLower: name.toLowerCase(), email: currentUser.email,
    bio, links, photoURL: editAvatarDataUrl || ''
  }, { merge: true });

  state.profile.name = name;
  state.profile.bio = bio;
  state.profile.links = links;
  state.profile.photoURL = editAvatarDataUrl || '';
  editProfileModal.classList.add('hidden');
  renderProfile();
});

// ---------- FRIENDS LIST (following / followers) ----------
let friendsMode = 'following';
document.getElementById('showFollowingChip').addEventListener('click', () => {
  friendsMode = 'following';
  document.getElementById('showFollowingChip').classList.add('active');
  document.getElementById('showFollowersChip').classList.remove('active');
  document.getElementById('friendsListTitle').textContent = 'Following';
  renderFriendsList();
});
document.getElementById('showFollowersChip').addEventListener('click', () => {
  friendsMode = 'followers';
  document.getElementById('showFollowersChip').classList.add('active');
  document.getElementById('showFollowingChip').classList.remove('active');
  document.getElementById('friendsListTitle').textContent = 'Followers';
  renderFriendsList();
});

async function isFollowing(uid) {
  const snap = await getDoc(doc(db, 'follows', `${currentUser.uid}_${uid}`));
  return snap.exists();
}

async function toggleFollow(uid, btnEl) {
  const following = btnEl.dataset.following === 'true';
  if (following) {
    await deleteDoc(doc(db, 'follows', `${currentUser.uid}_${uid}`));
    btnEl.textContent = 'Follow';
    btnEl.dataset.following = 'false';
  } else {
    await setDoc(doc(db, 'follows', `${currentUser.uid}_${uid}`), {
      followerId: currentUser.uid, followingId: uid, createdAt: serverTimestamp()
    });
    btnEl.textContent = 'Following';
    btnEl.dataset.following = 'true';
  }
  refreshFollowCounts().then(() => {
    document.getElementById('statFollowers').textContent = state.profile.followers;
    document.getElementById('statFollowing').textContent = state.profile.following;
  });
}

function buildPersonCard(uid, data, showFollowBtn, alreadyFollowing) {
  const card = document.createElement('div');
  card.className = 'dest-card';
  const avatarHtml = data.photoURL
    ? `<img src="${data.photoURL}" style="width:100%;height:100%;object-fit:cover;" />`
    : '👤';
  card.innerHTML = `
    <div class="dest-card-photo">${avatarHtml}</div>
    <div class="dest-card-body">
      <div class="dest-card-top-row">
        <span class="dest-card-name">${escapeHtml(data.name || 'Someone')}</span>
        ${showFollowBtn ? `<button class="btn-link follow-toggle-btn" data-following="${alreadyFollowing}">${alreadyFollowing ? 'Following' : 'Follow'}</button>` : ''}
      </div>
      ${data.bio ? `<span class="dest-card-meta">${escapeHtml(data.bio)}</span>` : ''}
    </div>
  `;
  card.addEventListener('click', () => openViewProfile(uid));
  if (showFollowBtn) {
    const btn = card.querySelector('.follow-toggle-btn');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFollow(uid, btn);
    });
  }
  return card;
}

async function renderFriendsList() {
  const list = document.getElementById('friendsList');
  const empty = document.getElementById('friendsEmpty');
  list.innerHTML = '';

  const field = friendsMode === 'following' ? 'followerId' : 'followingId';
  const otherField = friendsMode === 'following' ? 'followingId' : 'followerId';
  const snap = await getDocs(query(collection(db, 'follows'), where(field, '==', currentUser.uid)));
  empty.classList.toggle('hidden', snap.size > 0);

  const myFollowingSnap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', currentUser.uid)));
  const myFollowingIds = new Set(myFollowingSnap.docs.map(d => d.data().followingId));

  for (const followDoc of snap.docs) {
    const otherId = followDoc.data()[otherField];
    const userDoc = await getDoc(doc(db, 'users', otherId));
    if (!userDoc.exists()) continue;
    const showFollowBtn = friendsMode === 'followers';
    const card = buildPersonCard(otherId, userDoc.data(), showFollowBtn, myFollowingIds.has(otherId));
    if (friendsMode === 'following') {
      const btn = document.createElement('button');
      btn.className = 'btn-link follow-toggle-btn';
      btn.dataset.following = 'true';
      btn.textContent = 'Unfollow';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleFollow(otherId, btn).then(() => renderFriendsList());
      });
      card.querySelector('.dest-card-top-row').appendChild(btn);
    }
    list.appendChild(card);
  }
}

// ---------- USER SEARCH / FOLLOW ----------
let searchDebounce = null;
document.getElementById('userSearchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const term = e.target.value.trim();
  searchDebounce = setTimeout(() => searchUsers(term), 300);
});

async function searchUsers(term) {
  const resultsEl = document.getElementById('userSearchResults');
  resultsEl.innerHTML = '';
  if (!term) return;
  const termLower = term.toLowerCase();
  const snap = await getDocs(query(
    collection(db, 'users'),
    where('nameLower', '>=', termLower),
    where('nameLower', '<=', termLower + ''),
    limit(10)
  ));
  const myFollowingSnap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', currentUser.uid)));
  const myFollowingIds = new Set(myFollowingSnap.docs.map(d => d.data().followingId));

  snap.docs.forEach(userDoc => {
    if (userDoc.id === currentUser.uid) return;
    const card = buildPersonCard(userDoc.id, userDoc.data(), true, myFollowingIds.has(userDoc.id));
    resultsEl.appendChild(card);
  });
}

// ---------- VIEW PROFILE MODAL (read-only) ----------
const viewProfileModal = document.getElementById('viewProfileModal');
document.getElementById('closeViewProfileModal').addEventListener('click', () => viewProfileModal.classList.add('hidden'));

async function openViewProfile(uid) {
  if (!uid) return;
  if (uid === currentUser.uid) { switchTab('profile'); return; }

  const userDoc = await getDoc(doc(db, 'users', uid));
  if (!userDoc.exists()) return;
  const data = userDoc.data();

  const destsSnap = await getDocs(query(collection(db, 'destinations'), where('ownerId', '==', uid)));
  const ranked = destsSnap.docs.map(d => d.data()).filter(d => d.status === 'ranked').sort((a, b) => b.score - a.score);
  const avg = ranked.length ? (ranked.reduce((s, d) => s + d.score, 0) / ranked.length) : 0;

  const followingSnap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', uid)));
  const followersSnap = await getDocs(query(collection(db, 'follows'), where('followingId', '==', uid)));
  const alreadyFollowing = await isFollowing(uid);

  document.getElementById('viewProfileName').textContent = data.name || 'Profile';
  const avatarHtml = data.photoURL
    ? `<img src="${data.photoURL}" class="profile-avatar" />`
    : `<div class="profile-avatar profile-avatar-fallback">${escapeHtml((data.name || '?').charAt(0).toUpperCase())}</div>`;

  const topDestsHtml = ranked.slice(0, 8).map(d => `
    <div class="dest-card" style="cursor:default;">
      <div class="dest-card-photo" ${d.photos && d.photos[0] ? `style="background-image:url('${d.photos[0]}')"` : ''}>${d.photos && d.photos[0] ? '' : '📍'}</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row">
          <span class="dest-card-name">${escapeHtml(d.name)}</span>
          <span class="score-badge ${scoreClass(d.score)}">${formatScore(d.score)}</span>
        </div>
        <span class="dest-card-meta">${escapeHtml(d.category)}</span>
      </div>
    </div>
  `).join('');

  document.getElementById('viewProfileBody').innerHTML = `
    <div class="view-profile-header">
      ${avatarHtml}
      <div>
        <div class="profile-display-name">${escapeHtml(data.name || '')}</div>
        ${data.bio ? `<p class="profile-bio-display">${escapeHtml(data.bio)}</p>` : ''}
        <div class="profile-links-row">${buildLinksHtml(data.links)}</div>
      </div>
    </div>
    <div class="view-profile-stats">
      <div class="view-profile-stat"><span>${ranked.length}</span><label>Ranked</label></div>
      <div class="view-profile-stat"><span>${avg.toFixed(1)}</span><label>Avg Score</label></div>
      <div class="view-profile-stat"><span>${followersSnap.size}</span><label>Followers</label></div>
      <div class="view-profile-stat"><span>${followingSnap.size}</span><label>Following</label></div>
    </div>
    <button class="btn ${alreadyFollowing ? 'btn-secondary' : 'btn-primary'}" id="viewProfileFollowBtn" data-following="${alreadyFollowing}" style="width:100%; margin-bottom:16px;">${alreadyFollowing ? 'Following' : 'Follow'}</button>
    <h3>Top Destinations</h3>
    <div class="card-list">${topDestsHtml || '<p class="empty-state">No ranked destinations yet.</p>'}</div>
  `;

  document.getElementById('viewProfileFollowBtn').addEventListener('click', async (ev) => {
    await toggleFollow(uid, ev.target);
    ev.target.className = ev.target.dataset.following === 'true' ? 'btn btn-secondary' : 'btn btn-primary';
    ev.target.style.width = '100%';
    ev.target.style.marginBottom = '16px';
  });

  viewProfileModal.classList.remove('hidden');
}

// ---------- ADD DESTINATION MODAL FLOW ----------
const addModal = document.getElementById('addModal');
const stepDetails = document.getElementById('stepDetails');
const stepSentiment = document.getElementById('stepSentiment');
const stepCompare = document.getElementById('stepCompare');
const stepDone = document.getElementById('stepDone');

let pendingPhotos = [];
let pendingDest = null;
let editingExistingId = null;
let compareBucket = [];
let compareLo = 0, compareHi = 0, compareMid = 0;
let pendingLat = null;
let pendingLon = null;

function resetAddModal() {
  document.getElementById('destName').value = '';
  document.getElementById('destCategory').value = CATEGORIES[0];
  document.getElementById('destLocation').value = '';
  document.getElementById('destNotes').value = '';
  document.getElementById('destTags').value = '';
  document.getElementById('destPhotos').value = '';
  document.getElementById('photoPreview').innerHTML = '';
  document.getElementById('locationSuggestions').classList.add('hidden');
  pendingPhotos = [];
  pendingLat = null;
  pendingLon = null;
  editingExistingId = null;
  [stepDetails, stepSentiment, stepCompare, stepDone].forEach(s => s.classList.add('hidden'));
  stepDetails.classList.remove('hidden');
  document.getElementById('addModalTitle').textContent = 'Add a Destination';
}

// ---------- LOCATION AUTOCOMPLETE (OpenStreetMap Nominatim, free/no key) ----------
let locationDebounce = null;
const locationInput = document.getElementById('destLocation');
const locationSuggestionsEl = document.getElementById('locationSuggestions');

locationInput.addEventListener('input', () => {
  pendingLat = null;
  pendingLon = null;
  const term = locationInput.value.trim();
  clearTimeout(locationDebounce);
  if (term.length < 3) {
    locationSuggestionsEl.classList.add('hidden');
    return;
  }
  locationSuggestionsEl.innerHTML = '<div class="suggestion-loading">Searching...</div>';
  locationSuggestionsEl.classList.remove('hidden');
  locationDebounce = setTimeout(() => fetchLocationSuggestions(term), 400);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete-wrap')) {
    locationSuggestionsEl.classList.add('hidden');
  }
});

async function fetchLocationSuggestions(term) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(term)}&addressdetails=1&limit=6`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const results = await res.json();
    if (locationInput.value.trim() !== term) return; // stale response
    locationSuggestionsEl.innerHTML = '';
    if (!results.length) {
      locationSuggestionsEl.innerHTML = '<div class="suggestion-loading">No matches found</div>';
      return;
    }
    results.forEach(place => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = place.display_name;
      item.addEventListener('click', () => {
        locationInput.value = place.display_name;
        pendingLat = parseFloat(place.lat);
        pendingLon = parseFloat(place.lon);
        locationSuggestionsEl.classList.add('hidden');
      });
      locationSuggestionsEl.appendChild(item);
    });
  } catch (err) {
    locationSuggestionsEl.innerHTML = '<div class="suggestion-loading">Search failed, try again</div>';
  }
}
function openAddModal() { resetAddModal(); addModal.classList.remove('hidden'); }
document.getElementById('closeAddModal').addEventListener('click', () => addModal.classList.add('hidden'));

document.getElementById('destPhotos').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files).slice(0, MAX_PHOTOS);
  const preview = document.getElementById('photoPreview');
  preview.innerHTML = '';
  pendingPhotos = [];
  for (const file of files) {
    const dataUrl = await compressImage(file);
    pendingPhotos.push(dataUrl);
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = dataUrl;
    preview.appendChild(img);
  }
});

function gatherDetails() {
  return {
    name: document.getElementById('destName').value.trim(),
    category: document.getElementById('destCategory').value,
    location: document.getElementById('destLocation').value.trim(),
    lat: pendingLat,
    lon: pendingLon,
    notes: document.getElementById('destNotes').value.trim(),
    tags: document.getElementById('destTags').value.split(',').map(t => t.trim()).filter(Boolean),
    dateVisited: new Date().toISOString().slice(0, 10),
    photos: [...pendingPhotos],
    ownerId: currentUser.uid,
    ownerName: state.profile.name || currentUser.email
  };
}

document.getElementById('saveWantBtn').addEventListener('click', async () => {
  const details = gatherDetails();
  if (!details.name) { alert('Please enter a name.'); return; }
  await addDoc(collection(db, 'destinations'), { ...details, status: 'want', createdAt: serverTimestamp() });
  addModal.classList.add('hidden');
});

document.getElementById('startRankingBtn').addEventListener('click', () => {
  const details = gatherDetails();
  if (!details.name) { alert('Please enter a name.'); return; }
  pendingDest = details;
  stepDetails.classList.add('hidden');
  stepSentiment.classList.remove('hidden');
  document.getElementById('addModalTitle').textContent = 'How was it?';
});

document.querySelectorAll('.sentiment-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    pendingDest.sentiment = btn.dataset.sentiment;
    beginComparisons(btn.dataset.sentiment);
  });
});

function bucketFor(category, sentiment) {
  return state.destinations
    .filter(d => d.category === category && d.sentiment === sentiment && d.id !== editingExistingId)
    .sort((a, b) => b.score - a.score);
}

function beginComparisons(sentiment) {
  compareBucket = bucketFor(pendingDest.category, sentiment);
  if (compareBucket.length === 0) { finalizeRanking(0, 1); return; }
  compareLo = 0; compareHi = compareBucket.length;
  document.getElementById('addModalTitle').textContent = 'Rank It';
  runNextComparison();
}

function runNextComparison() {
  if (compareLo >= compareHi) { finalizeRanking(compareLo, compareBucket.length + 1); return; }
  compareMid = Math.floor((compareLo + compareHi) / 2);
  stepSentiment.classList.add('hidden');
  stepCompare.classList.remove('hidden');
  const other = compareBucket[compareMid];
  document.getElementById('comparePrompt').textContent = 'Which did you like more?';
  document.getElementById('compareOptionA').textContent = pendingDest.name;
  document.getElementById('compareOptionB').textContent = other.name;
}

document.getElementById('compareOptionA').addEventListener('click', () => {
  compareHi = compareMid; stepCompare.classList.add('hidden'); runNextComparison();
});
document.getElementById('compareOptionB').addEventListener('click', () => {
  compareLo = compareMid + 1; stepCompare.classList.add('hidden'); runNextComparison();
});
document.getElementById('tieBtn').addEventListener('click', () => {
  finalizeRanking(compareMid + 1, compareBucket.length + 1);
});

async function finalizeRanking(insertIndex, newBucketSize) {
  const range = SENTIMENT_RANGES[pendingDest.sentiment];
  const finalList = [...compareBucket];
  finalList.splice(insertIndex, 0, pendingDest);

  for (let i = 0; i < finalList.length; i++) {
    const destItem = finalList[i];
    const score = newBucketSize === 1
      ? (range.min + range.max) / 2
      : range.max - (i * (range.max - range.min)) / (newBucketSize - 1);
    destItem.score = Math.round(score * 10) / 10;

    if (destItem === pendingDest) {
      if (editingExistingId) {
        await updateDoc(doc(db, 'destinations', editingExistingId), {
          ...destItem, status: 'ranked', createdAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, 'destinations'), { ...destItem, status: 'ranked', createdAt: serverTimestamp() });
      }
    } else {
      await updateDoc(doc(db, 'destinations', destItem.id), { score: destItem.score });
    }
  }
  showDone(pendingDest.score);
}

function showDone(score) {
  stepCompare.classList.add('hidden');
  stepSentiment.classList.add('hidden');
  stepDone.classList.remove('hidden');
  document.getElementById('doneScore').textContent = formatScore(score);
  document.getElementById('doneMessage').textContent = `${pendingDest.name} added to your rankings!`;
  document.getElementById('addModalTitle').textContent = 'Ranked!';
}
document.getElementById('finishBtn').addEventListener('click', () => addModal.classList.add('hidden'));

// ---------- DETAIL MODAL ----------
const detailModal = document.getElementById('detailModal');
document.getElementById('closeDetailModal').addEventListener('click', () => detailModal.classList.add('hidden'));

function openDetailModal(id, isWant) {
  const list = isWant ? state.wantToVisit : state.destinations;
  const dest = list.find(d => d.id === id);
  if (!dest) return;
  document.getElementById('detailName').textContent = dest.name;
  const photosHtml = (dest.photos || []).map(p => `<img src="${p}" />`).join('');
  const body = document.getElementById('detailBody');
  body.innerHTML = `
    ${photosHtml ? `<div class="detail-photos">${photosHtml}</div>` : ''}
    <div class="detail-row"><label>Category</label>${escapeHtml(dest.category)}</div>
    <div class="detail-row"><label>Location</label>${escapeHtml(dest.location || '—')}${dest.lat && dest.lon ? ` · <a href="https://www.openstreetmap.org/?mlat=${dest.lat}&mlon=${dest.lon}#map=14/${dest.lat}/${dest.lon}" target="_blank" rel="noopener">View on map</a>` : ''}</div>
    ${!isWant ? `<div class="detail-row"><label>Score</label><span class="score-badge ${scoreClass(dest.score)}" style="display:inline-flex">${formatScore(dest.score)}</span></div>` : ''}
    ${dest.notes ? `<div class="detail-row"><label>Notes</label>${escapeHtml(dest.notes)}</div>` : ''}
    ${dest.tags && dest.tags.length ? `<div class="detail-row"><label>Tags</label>${escapeHtml(dest.tags.join(', '))}</div>` : ''}
    <div class="detail-row"><label>Date</label>${dest.dateVisited}</div>
    <div class="detail-actions">
      ${isWant ? `<button class="btn btn-primary" id="markVisitedBtn">Mark as Visited</button>` : ''}
      <button class="btn btn-secondary" id="editDestBtn">Edit</button>
      <button class="btn btn-danger" id="deleteBtn">Delete</button>
    </div>
  `;

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${dest.name}?`)) return;
    await deleteDoc(doc(db, 'destinations', id));
    detailModal.classList.add('hidden');
  });

  document.getElementById('editDestBtn').addEventListener('click', () => {
    detailModal.classList.add('hidden');
    openEditDestModal(dest);
  });

  if (isWant) {
    document.getElementById('markVisitedBtn').addEventListener('click', () => {
      detailModal.classList.add('hidden');
      pendingDest = { ...dest };
      pendingPhotos = dest.photos || [];
      editingExistingId = dest.id;
      addModal.classList.remove('hidden');
      stepDetails.classList.add('hidden');
      stepSentiment.classList.remove('hidden');
      document.getElementById('addModalTitle').textContent = 'How was it?';
    });
  }

  detailModal.classList.remove('hidden');
}

// ---------- EDIT DESTINATION MODAL ----------
const editDestModal = document.getElementById('editDestModal');
let editDestId = null;
let editDestPhotos = [];

function openEditDestModal(dest) {
  editDestId = dest.id;
  editDestPhotos = [...(dest.photos || [])];
  document.getElementById('editDestName').value = dest.name;
  document.getElementById('editDestLocation').value = dest.location || '';
  document.getElementById('editDestNotes').value = dest.notes || '';
  document.getElementById('editDestTags').value = (dest.tags || []).join(', ');
  document.getElementById('editDestPhotos').value = '';
  renderEditPhotoPreview();
  editDestModal.classList.remove('hidden');
}
document.getElementById('closeEditDestModal').addEventListener('click', () => editDestModal.classList.add('hidden'));

function renderEditPhotoPreview() {
  const preview = document.getElementById('editPhotoPreview');
  preview.innerHTML = '';
  editDestPhotos.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.innerHTML = `<img class="photo-thumb" src="${src}" /><button class="photo-remove-btn" data-i="${i}">✕</button>`;
    preview.appendChild(wrap);
  });
  preview.querySelectorAll('.photo-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editDestPhotos.splice(Number(btn.dataset.i), 1);
      renderEditPhotoPreview();
    });
  });
}

document.getElementById('editDestPhotos').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files).slice(0, MAX_PHOTOS - editDestPhotos.length);
  for (const file of files) {
    editDestPhotos.push(await compressImage(file));
  }
  renderEditPhotoPreview();
});

document.getElementById('saveEditDestBtn').addEventListener('click', async () => {
  const name = document.getElementById('editDestName').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  await updateDoc(doc(db, 'destinations', editDestId), {
    name,
    location: document.getElementById('editDestLocation').value.trim(),
    notes: document.getElementById('editDestNotes').value.trim(),
    tags: document.getElementById('editDestTags').value.split(',').map(t => t.trim()).filter(Boolean),
    photos: editDestPhotos
  });
  editDestModal.classList.add('hidden');
});

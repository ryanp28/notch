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

let currentUser = null;
let unsubscribeDestinations = null;
let state = { destinations: [], wantToVisit: [], profile: { name: '', followers: 0, following: 0 } };

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
    state.profile.name = userDoc.exists() ? userDoc.data().name : (user.displayName || '');
    attachDestinationsListener();
    refreshFollowCounts();
    switchTab('feed');
  } else {
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('mainApp').classList.add('hidden');
    if (unsubscribeDestinations) { unsubscribeDestinations(); unsubscribeDestinations = null; }
    state = { destinations: [], wantToVisit: [], profile: { name: '', followers: 0, following: 0 } };
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
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxWidth = 800;
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
      if (data.status === 'ranked') items.push(data);
    });
  }
  items.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  items = items.slice(0, 25);

  if (items.length === 0) {
    hint.textContent = "Your friends haven't ranked anything yet.";
    hint.classList.remove('hidden');
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'feed-card';
    const initials = (item.ownerName || '?').charAt(0).toUpperCase();
    const photo = item.photos && item.photos[0] ? item.photos[0] : '';
    card.innerHTML = `
      <div class="feed-user-row">
        <div class="feed-avatar">${initials}</div>
        <div>
          <div class="feed-username">${item.ownerName || 'Someone'}</div>
          <div class="feed-action">ranked a new destination</div>
        </div>
      </div>
      ${photo ? `<div class="feed-photo" style="background-image:url('${photo}')"></div>` : ''}
      <div class="feed-caption"><strong>${item.name}</strong> · ${item.category} · Score ${formatScore(item.score)}</div>
    `;
    list.appendChild(card);
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

function renderRankings() {
  renderCategoryFilters();
  const list = document.getElementById('rankingsList');
  const empty = document.getElementById('rankingsEmpty');
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();

  let items = [...state.destinations];
  if (activeCategoryFilter !== 'All') items = items.filter(d => d.category === activeCategoryFilter);
  if (searchTerm) items = items.filter(d => d.name.toLowerCase().includes(searchTerm));
  items.sort((a, b) => b.score - a.score);

  list.innerHTML = '';
  empty.classList.toggle('hidden', items.length > 0 || state.destinations.length > 0);
  if (state.destinations.length === 0) return;

  items.forEach((dest, idx) => {
    const card = document.createElement('button');
    card.className = 'dest-card';
    const cover = dest.photos && dest.photos[0] ? `style="background-image:url('${dest.photos[0]}')"` : '';
    card.innerHTML = `
      <div class="dest-card-photo" ${cover}>${dest.photos && dest.photos[0] ? '' : '📍'}</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row">
          <span class="dest-card-name">${dest.name}</span>
          <span class="score-badge ${scoreClass(dest.score)}">${formatScore(dest.score)}</span>
        </div>
        <span class="dest-card-meta">${dest.category} · ${dest.location || 'No location'}</span>
        <span class="rank-badge">#${idx + 1} in ${dest.category}</span>
      </div>
    `;
    card.addEventListener('click', () => openDetailModal(dest.id, false));
    list.appendChild(card);
  });
}
document.getElementById('searchInput').addEventListener('input', renderRankings);

// ---------- RENDER: WANT TO VISIT ----------
function renderWantList() {
  const list = document.getElementById('wantList');
  const empty = document.getElementById('wantEmpty');
  list.innerHTML = '';
  empty.classList.toggle('hidden', state.wantToVisit.length > 0);
  state.wantToVisit.forEach(dest => {
    const card = document.createElement('button');
    card.className = 'dest-card';
    const cover = dest.photos && dest.photos[0] ? `style="background-image:url('${dest.photos[0]}')"` : '';
    card.innerHTML = `
      <div class="dest-card-photo" ${cover}>${dest.photos && dest.photos[0] ? '' : '🔖'}</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row"><span class="dest-card-name">${dest.name}</span></div>
        <span class="dest-card-meta">${dest.category} · ${dest.location || 'No location'}</span>
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

async function renderProfile() {
  document.getElementById('profileName').value = state.profile.name || '';
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
    row.innerHTML = `<span>${cat}</span><span>${items.length} ranked</span>`;
    catStatsEl.appendChild(row);
  });

  renderFollowingList();
}

document.getElementById('profileName').addEventListener('change', async (e) => {
  const name = e.target.value.trim();
  state.profile.name = name;
  await setDoc(doc(db, 'users', currentUser.uid), {
    name, nameLower: name.toLowerCase(), email: currentUser.email
  }, { merge: true });
});

async function renderFollowingList() {
  const list = document.getElementById('followingList');
  const empty = document.getElementById('followingEmpty');
  list.innerHTML = '';
  const snap = await getDocs(query(collection(db, 'follows'), where('followerId', '==', currentUser.uid)));
  empty.classList.toggle('hidden', snap.size > 0);
  for (const followDoc of snap.docs) {
    const followingId = followDoc.data().followingId;
    const userDoc = await getDoc(doc(db, 'users', followingId));
    if (!userDoc.exists()) continue;
    const card = document.createElement('div');
    card.className = 'dest-card';
    card.innerHTML = `
      <div class="dest-card-photo">👤</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row">
          <span class="dest-card-name">${userDoc.data().name}</span>
          <button class="btn-link unfollow-btn">Unfollow</button>
        </div>
      </div>
    `;
    card.querySelector('.unfollow-btn').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await deleteDoc(doc(db, 'follows', `${currentUser.uid}_${followingId}`));
      renderFollowingList();
      refreshFollowCounts();
    });
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
    const data = userDoc.data();
    const alreadyFollowing = myFollowingIds.has(userDoc.id);
    const card = document.createElement('div');
    card.className = 'dest-card';
    card.innerHTML = `
      <div class="dest-card-photo">👤</div>
      <div class="dest-card-body">
        <div class="dest-card-top-row">
          <span class="dest-card-name">${data.name}</span>
          <button class="btn-link follow-btn">${alreadyFollowing ? 'Following' : 'Follow'}</button>
        </div>
      </div>
    `;
    const followBtn = card.querySelector('.follow-btn');
    followBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (followBtn.textContent === 'Follow') {
        await setDoc(doc(db, 'follows', `${currentUser.uid}_${userDoc.id}`), {
          followerId: currentUser.uid, followingId: userDoc.id, createdAt: serverTimestamp()
        });
        followBtn.textContent = 'Following';
      } else {
        await deleteDoc(doc(db, 'follows', `${currentUser.uid}_${userDoc.id}`));
        followBtn.textContent = 'Follow';
      }
      refreshFollowCounts();
      renderFollowingList();
    });
    resultsEl.appendChild(card);
  });
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

function resetAddModal() {
  document.getElementById('destName').value = '';
  document.getElementById('destCategory').value = CATEGORIES[0];
  document.getElementById('destLocation').value = '';
  document.getElementById('destNotes').value = '';
  document.getElementById('destTags').value = '';
  document.getElementById('destPhotos').value = '';
  document.getElementById('photoPreview').innerHTML = '';
  pendingPhotos = [];
  editingExistingId = null;
  [stepDetails, stepSentiment, stepCompare, stepDone].forEach(s => s.classList.add('hidden'));
  stepDetails.classList.remove('hidden');
  document.getElementById('addModalTitle').textContent = 'Add a Destination';
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
    <div class="detail-row"><label>Category</label>${dest.category}</div>
    <div class="detail-row"><label>Location</label>${dest.location || '—'}</div>
    ${!isWant ? `<div class="detail-row"><label>Score</label><span class="score-badge ${scoreClass(dest.score)}" style="display:inline-flex">${formatScore(dest.score)}</span></div>` : ''}
    ${dest.notes ? `<div class="detail-row"><label>Notes</label>${dest.notes}</div>` : ''}
    ${dest.tags && dest.tags.length ? `<div class="detail-row"><label>Tags</label>${dest.tags.join(', ')}</div>` : ''}
    <div class="detail-row"><label>Date</label>${dest.dateVisited}</div>
    <div class="detail-actions">
      ${isWant ? `<button class="btn btn-primary" id="markVisitedBtn">Mark as Visited</button>` : ''}
      <button class="btn btn-danger" id="deleteBtn">Delete</button>
    </div>
  `;

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${dest.name}?`)) return;
    await deleteDoc(doc(db, 'destinations', id));
    detailModal.classList.add('hidden');
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

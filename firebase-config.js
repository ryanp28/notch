import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Paste the config object from your Firebase project settings here.
// These values are safe to be public — Firebase Console → Project settings → your web app.
const firebaseConfig = {
  apiKey: "AIzaSyAqENvr1gFPhJnBD4y3km_ZR7U2sNKszjw",
  authDomain: "notch-app-c4b99.firebaseapp.com",
  projectId: "notch-app-c4b99",
  storageBucket: "notch-app-c4b99.firebasestorage.app",
  messagingSenderId: "580912112436",
  appId: "1:580912112436:web:1ee7f58302877f56a9bb61"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

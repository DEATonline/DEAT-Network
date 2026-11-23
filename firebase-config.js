// Public Firebase Web App Configuration
// Note: Firebase web config identifiers are safe to commit once you apply:
// 1. Firestore Security Rules (restricting writes to authenticated editors only)
// 2. Google Cloud API Key HTTP Referrer restrictions (allowing only your GitHub Pages domain)

window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const firebaseConfig = window.PYP_FIREBASE_CONFIG || {};
const status = document.getElementById("account-status");
const form = document.getElementById("account-form");
const emailInput = document.getElementById("account-email");
const passwordInput = document.getElementById("account-password");
const resetButton = document.getElementById("account-reset-password");
const logoutButton = document.getElementById("account-logout");
const retryButton = document.getElementById("account-sync-retry");
const authButtons = form.querySelectorAll("[data-auth-action]");
const configReady = ["apiKey", "authDomain", "projectId", "appId"]
  .every(key => typeof firebaseConfig[key] === "string" && firebaseConfig[key].trim());

let auth;
let database;
let firebaseAuth;
let firestore;
let signedInUid = null;
let saveTimer = null;
let cloudReady = false;
let pendingLocalState = null;

function setStatus(message) {
  status.textContent = message;
}

function setAccountControls(enabled) {
  authButtons.forEach(button => { button.disabled = !enabled; });
  resetButton.disabled = !enabled;
  logoutButton.hidden = !signedInUid;
}

function hasProgress(data) {
  if (!data || typeof data !== "object") return false;
  return Number(data.xp) > 0 ||
    ["habits", "quests", "workouts", "runs", "plans", "projects", "schedule", "screenTime"]
      .some(key => Array.isArray(data[key]) && data[key].length > 0) ||
    (data.challengeDone && Object.values(data.challengeDone).some(items => Array.isArray(items) && items.length > 0));
}

function mergeData(local, remote) {
  const merged = { ...remote, ...local };
  for (const key of ["habits", "quests", "workouts", "runs", "plans", "projects", "schedule", "challenges"]) {
    const entries = new Map((remote[key] || []).map(item => [item.id || JSON.stringify(item), item]));
    (local[key] || []).forEach(item => entries.set(item.id || JSON.stringify(item), item));
    merged[key] = Array.from(entries.values());
  }

  const screenTime = new Map((remote.screenTime || []).map(item => [item.date, item]));
  (local.screenTime || []).forEach(item => screenTime.set(item.date, item));
  merged.screenTime = Array.from(screenTime.values());
  merged.challengeDone = { ...(remote.challengeDone || {}) };
  for (const [date, items] of Object.entries(local.challengeDone || {})) {
    merged.challengeDone[date] = Array.from(new Set([...(merged.challengeDone[date] || []), ...items]));
  }
  merged.xp = Math.max(Number(local.xp) || 0, Number(remote.xp) || 0);
  merged.createdAt = remote.createdAt || local.createdAt;
  return merged;
}

function localData() {
  try {
    const raw = localStorage.getItem("pypData");
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("Lokale PYP-Daten konnten nicht für die Synchronisierung gelesen werden:", error);
    throw new Error("Lokale Daten konnten nicht gelesen werden. Bitte exportiere ein Backup, bevor du fortfährst.");
  }
}

function userDataRef(uid) {
  return firestore.doc(database, "users", uid, "appData", "main");
}

async function syncUserData(user) {
  cloudReady = false;
  pendingLocalState = null;
  retryButton.hidden = true;
  setAccountControls(false);
  signedInUid = user.uid;
  logoutButton.hidden = false;
  emailInput.value = user.email || emailInput.value;
  setStatus(`Angemeldet als ${user.email || "Konto"}. Cloud-Daten werden geladen …`);

  try {
    const snapshot = await firestore.getDoc(userDataRef(user.uid));
    const local = localData();
    const localOwner = localStorage.getItem("pypCloudUid");
    const sameAccount = !localOwner || localOwner === user.uid;
    let data;

    if (snapshot.exists()) {
      const remote = snapshot.data().state;
      if (!remote || typeof remote !== "object") throw new Error("Das Cloud-Backup hat ein ungültiges Format.");
      if (sameAccount && hasProgress(local)) {
        data = mergeData(local, remote);
        setStatus("Lokale und Cloud-Daten wurden zusammengeführt.");
      } else {
        data = remote;
        setStatus("Cloud-Daten geladen.");
      }
    } else if (sameAccount && hasProgress(local)) {
      data = local;
      setStatus("Deine vorhandenen Daten werden erstmals in deinem Konto gesichert.");
    } else {
      data = null;
      const differentAccount = localOwner && localOwner !== user.uid;
      setStatus(differentAccount
        ? "Dieses Konto ist angemeldet. Die Daten eines anderen Kontos wurden nicht übertragen."
        : "Konto bereit. Deine Daten werden ab jetzt synchronisiert.");
      if (differentAccount) window.dispatchEvent(new CustomEvent("pyp:cloud-reset"));
    }

    localStorage.setItem("pypCloudUid", user.uid);
    while (true) {
      const pending = pendingLocalState;
      pendingLocalState = null;
      if (pending) data = data ? mergeData(pending, data) : pending;
      if (data) {
        await firestore.setDoc(userDataRef(user.uid), {
          state: data,
          updatedAt: firestore.serverTimestamp()
        });
      }
      if (!pendingLocalState) break;
    }
    if (data) {
      cloudReady = true;
      setAccountControls(true);
      setStatus(`Angemeldet als ${user.email || "Konto"} · synchronisiert.`);
      window.dispatchEvent(new CustomEvent("pyp:cloud-state", { detail: { state: data } }));
    } else {
      cloudReady = true;
      setAccountControls(true);
      if (!snapshot.exists() && sameAccount) {
        const current = localData();
        if (current) {
          window.dispatchEvent(new CustomEvent("pyp:cloud-state", { detail: { state: current } }));
        }
      }
    }
  } catch (error) {
    console.error("Firebase-Synchronisierung fehlgeschlagen:", error);
    setStatus(`Synchronisierung fehlgeschlagen. Die lokale Kopie bleibt erhalten. ${error.message}`);
    retryButton.hidden = false;
    setAccountControls(true);
  }
}

async function saveCloudState(state) {
  if (!signedInUid) return;
  try {
    await firestore.setDoc(userDataRef(signedInUid), {
      state,
      updatedAt: firestore.serverTimestamp()
    });
    setStatus(`Angemeldet als ${auth.currentUser?.email || "Konto"} · synchronisiert.`);
  } catch (error) {
    console.error("Cloud-Sicherung fehlgeschlagen:", error);
    setStatus(`Cloud-Sicherung fehlgeschlagen; deine lokale Kopie bleibt erhalten. ${error.message}`);
  }
}

if (!configReady) {
  setAccountControls(false);
  setStatus("Cloud-Konto ist noch nicht eingerichtet. Folge den Firebase-Schritten unten; PYP speichert bis dahin nur auf diesem Gerät.");
} else {
  initializeFirebase();
}

async function initializeFirebase() {
  try {
    const version = "10.14.1";
    [firebaseAuth, firestore] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`)
    ]);
    const appModule = await import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`);
    const app = appModule.initializeApp(firebaseConfig);
    auth = firebaseAuth.getAuth(app);
    database = firestore.getFirestore(app);
    setAccountControls(true);

    firebaseAuth.onAuthStateChanged(auth, user => {
      if (saveTimer) clearTimeout(saveTimer);
      if (user) {
        syncUserData(user);
      } else {
        signedInUid = null;
        cloudReady = false;
        pendingLocalState = null;
        logoutButton.hidden = true;
        retryButton.hidden = true;
        setAccountControls(true);
        setStatus("Nicht angemeldet. Deine aktuelle Kopie bleibt auf diesem Gerät.");
      }
    }, error => {
      console.error("Firebase-Anmeldestatus konnte nicht geladen werden:", error);
      setStatus(`Anmeldestatus konnte nicht geladen werden. ${error.message}`);
    });

    form.addEventListener("submit", async event => {
      event.preventDefault();
      const action = event.submitter?.dataset.authAction;
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || password.length < 8) {
        setStatus("Gib eine gültige E-Mail-Adresse und ein Passwort mit mindestens 8 Zeichen ein.");
        return;
      }

      setAccountControls(false);
      try {
        if (action === "signup") await firebaseAuth.createUserWithEmailAndPassword(auth, email, password);
        else await firebaseAuth.signInWithEmailAndPassword(auth, email, password);
      } catch (error) {
        console.error("Firebase-Anmeldung fehlgeschlagen:", error);
        setStatus(`Anmeldung fehlgeschlagen. ${error.message}`);
        setAccountControls(true);
      } finally {
        passwordInput.value = "";
      }
    });

    resetButton.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      if (!email) {
        setStatus("Gib zuerst deine E-Mail-Adresse ein.");
        return;
      }
      try {
        await firebaseAuth.sendPasswordResetEmail(auth, email);
        setStatus("Falls zu dieser Adresse ein Konto besteht, wurde eine E-Mail zum Zurücksetzen des Passworts gesendet.");
      } catch (error) {
        console.error("Passwort-Zurücksetzen fehlgeschlagen:", error);
        setStatus(`Passwort konnte nicht zurückgesetzt werden. ${error.message}`);
      }
    });

    retryButton.addEventListener("click", () => {
      if (auth.currentUser) syncUserData(auth.currentUser);
    });

    logoutButton.addEventListener("click", async () => {
      try {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          await saveCloudState(localData());
        }
        await firebaseAuth.signOut(auth);
      } catch (error) {
        console.error("Abmelden fehlgeschlagen:", error);
        setStatus(`Abmelden fehlgeschlagen. ${error.message}`);
      }
    });

    window.addEventListener("pyp:local-save", event => {
      if (!signedInUid) return;
      if (!cloudReady) {
        pendingLocalState = event.detail.state;
        return;
      }
      if (saveTimer) clearTimeout(saveTimer);
      const state = event.detail.state;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveCloudState(state);
      }, 700);
    });
  } catch (error) {
    console.error("Firebase konnte nicht initialisiert werden:", error);
    setAccountControls(false);
    setStatus(`Firebase konnte nicht geladen werden. Prüfe die Konfiguration und Internetverbindung. ${error.message}`);
  }
}


const OPENAI_API_KEY = "HIDDEN"
// ------------------------------------------------
// 1. CONFIGURATION
// ------------------------------------------------
const firebaseConfig = {
    "HIDDEN"
};
const GOOGLE_SCRIPT_URL = "HIDDEN"
// Global Variables
let allItemsData = [];
let currentCalendarDate = new Date();
const donationGrid = document.getElementById('donationGrid');

// ------------------------------------------------
// 2. HELPER FUNCTIONS
// ------------------------------------------------
const toBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
});

function calculateExpiryDate(purchaseDateStr, daysToSpoil) {
    const boughtDate = new Date(purchaseDateStr + 'T00:00:00');
    const expiryDate = new Date(boughtDate);
    expiryDate.setDate(boughtDate.getDate() + parseInt(daysToSpoil));
    return expiryDate;
}

function formatDateReadable(dateObj) {
    return dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function showToast(message) {
    // Create toast element dynamically if missing
    let x = document.getElementById("toast");
    if (!x) {
        x = document.createElement("div");
        x.id = "toast";
        document.body.appendChild(x);
    }
    x.innerText = message;
    x.className = "show";
    setTimeout(function(){ x.className = x.className.replace("show", ""); }, 3000);
}

// ------------------------------------------------
// 3. MAIN LOGIC
// ------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
    const loadEl = document.querySelector('#load');
    
    // UI Elements (Might be null on donate.html)
    const loginSection = document.getElementById('loginSection');
    const appSection = document.getElementById('appSection');
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const userName = document.getElementById('userName');
    const cameraInput = document.getElementById('cameraInput');
    const imagePreview = document.getElementById('imagePreview');
    const previewContainer = document.getElementById('previewContainer');
    const statusMsg = document.getElementById('statusMsg');

    let unsubscribe;

    // Initialize Firebase
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    else firebase.app();

    const auth = firebase.auth();
    const db = firebase.firestore();
    if (loadEl) loadEl.textContent = '';

    // --- AUTHENTICATION LISTENERS (Safe Checks) ---
    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            const provider = new firebase.auth.GoogleAuthProvider();
            provider.addScope('https://www.googleapis.com/auth/tasks');
            try {
                const result = await auth.signInWithPopup(provider);
                localStorage.setItem('google_access_token', result.credential.accessToken);
            } catch (e) {
                showToast("Login Failed: " + e.message);
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (unsubscribe) unsubscribe();
            localStorage.removeItem('google_access_token');
            auth.signOut();
        });
    }

    // --- AUTH STATE LISTENER ---
    auth.onAuthStateChanged(async user => {
        if (user) {
            // Update UI if elements exist
            if(loginSection) loginSection.classList.add('hidden');
            if(appSection) appSection.classList.remove('hidden');
            if(userName) userName.textContent = user.displayName;
            const userInfo = document.getElementById('userInfo');
            if(userInfo) userInfo.classList.remove('hidden');

            // Ensure User Exists in DB
            const userRef = db.collection('users').doc(user.uid);
            const doc = await userRef.get();
            if (!doc.exists) {
                await userRef.set({
                    name: user.displayName,
                    email: user.email,
                    joined_at: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            // ONLY START LISTENER IF WE ARE ON THE DASHBOARD
            // We check if 'triageList' exists to know if we are on index.html
            if (document.getElementById('triageList')) {
                const itemsRef = db.collection('users').doc(user.uid).collection('items');
                unsubscribe = itemsRef.onSnapshot(snapshot => {
                    allItemsData = [];
                    snapshot.forEach(doc => {
                        const data = doc.data();
                        const expiry = calculateExpiryDate(data.date, data.spoil);
                        allItemsData.push({
                            id: doc.id,
                            ...data,
                            expiryDateObj: expiry
                        });
                    });
                    renderSidebar();
                    renderCalendar();
                });
            }

        } else {
            // User Logged Out
            if(loginSection) loginSection.classList.remove('hidden');
            if(appSection) appSection.classList.add('hidden');
        }
    });

    // --- CAMERA LOGIC (Safe Check) ---
    if (cameraInput) {
        cameraInput.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            imagePreview.src = URL.createObjectURL(file);
            previewContainer.classList.remove('hidden');
            statusMsg.textContent = "🤖 AI is reading receipt...";

            const user = auth.currentUser;
            if (!user) return;

            try {
                const base64Image = await toBase64(file);
                const result = await analyzeReceipt(base64Image);
                const items = result.items;

                if (items.length === 0) {
                    statusMsg.textContent = "⚠️ No fresh items found.";
                    return;
                }

                statusMsg.textContent = `💾 Found ${items.length} items! Saving...`;
                const batch = db.batch();
                items.forEach(item => {
                    const newDocRef = db.collection('users').doc(user.uid).collection('items').doc();
                    batch.set(newDocRef, {
                        item: item.item,
                        category: item.category,
                        spoil: item.spoil,
                        date: new Date().toISOString().split('T')[0],
                        created_at: firebase.firestore.FieldValue.serverTimestamp()
                    });
                });
                await batch.commit();
                statusMsg.textContent = "✅ Success! Saved to Pantry.";
                setTimeout(() => previewContainer.classList.add('hidden'), 2000);

            } catch (e) {
                console.error(e);
                statusMsg.textContent = "❌ Error: " + e.message;
            }
        });
    }

    // --- CALENDAR NAVIGATION (Safe Check) ---
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
            renderCalendar();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
            renderCalendar();
        });
    }
});

// ------------------------------------------------
// 4. RENDERING FUNCTIONS
// ------------------------------------------------

function renderSidebar() {
    const listContainer = document.getElementById('triageList');
    if (!listContainer) return; // Exit if not on dashboard

    listContainer.innerHTML = '';
    const sorted = [...allItemsData].sort((a, b) => a.expiryDateObj - b.expiryDateObj);

    if (sorted.length === 0) {
        listContainer.innerHTML = '<p style="color:#999; text-align:center;">No items.</p>';
        return;
    }

    sorted.forEach(item => {
        renderItemCard(item, listContainer);
    });
}

function renderItemCard(item, container) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffTime = item.expiryDateObj - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    let borderClass = 'safe'; 
    if (diffDays <= 2) borderClass = 'urgent'; 
    else if (diffDays <= 4) borderClass = 'soon'; 

    let statusBadge = '';
    let statusClass = '';
    
    if (item.status === 'listed') {
        statusBadge = '<span style="color:var(--hf-green); font-weight:bold; font-size:0.8rem;">(Listed*)</span>';
        statusClass = 'listed-item'; 
    } else if (item.status === 'pending') {
         statusBadge = '<span style="color:#F4B400; font-weight:bold; font-size:0.8rem;">(Claim Pending...)</span>';
    }

    const card = document.createElement('div');
    card.className = `food-card ${borderClass} ${statusClass}`;
    card.style.cursor = "pointer";
    card.onclick = () => openModal(item, diffDays);

    card.innerHTML = `
        <div>
            <strong>${item.item} ${statusBadge}</strong><br>
            <small>${item.category}</small>
        </div>
        <div class="days-left">
            ${diffDays}d
        </div>
    `;

    container.appendChild(card);
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const title = document.getElementById('calendarTitle');
    if (!grid) return; // Exit if not on dashboard

    grid.innerHTML = '';

    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    title.innerText = currentCalendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const firstDayIndex = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'cal-day empty';
        emptyCell.style.background = '#fcfcfc';
        grid.appendChild(emptyCell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.className = 'cal-day';

        const today = new Date();
        if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            cell.classList.add('today');
        }

        cell.innerHTML = `<div class="day-number">${day}</div>`;

        const cellDate = new Date(year, month, day);
        cellDate.setHours(0, 0, 0, 0);

        const daysItems = allItemsData.filter(item => {
            const itemDate = new Date(item.expiryDateObj);
            itemDate.setHours(0, 0, 0, 0);
            return itemDate.getTime() === cellDate.getTime();
        });

        daysItems.forEach(item => {
            const pill = document.createElement('div');
            let pillClass = 'cal-item-pill';
            if (item.spoil > 4) pillClass += ' safe';
            else if (item.spoil > 2) pillClass += ' soon';
            else pillClass += ' urgent';

            pill.className = pillClass;
            pill.innerText = item.item;

            pill.onclick = (e) => {
                e.stopPropagation();
                const daysLeft = Math.ceil((item.expiryDateObj - new Date()) / (1000 * 60 * 60 * 24));
                openModal(item, daysLeft);
            };
            cell.appendChild(pill);
        });
        grid.appendChild(cell);
    }
}

// ------------------------------------------------
// 5. EXTERNAL SERVICES (OpenAI, Google Tasks, Modal)
// ------------------------------------------------

async function analyzeReceipt(base64Image) {
    const prompt = `
    Analyze this grocery receipt. 
    1. Extract **ONLY** highly perishable items (Fresh Fruit, Vegetables, Raw Meat/Fish, Bakery).
    2. **IGNORE** shelf-stable items (Cans, Boxes, Frozen, Toiletries, Milk/Yogurt with printed dates).
    3. For each kept item, estimate "spoil" (days until unsafe) based on typical fridge life.
    
    Return a STRICT JSON object:
    {
        "items": [
            { "item": "Strawberries", "category": "Fruit", "spoil": 3 },
            { "item": "Ground Beef", "category": "Meat", "spoil": 2 }
        ]
    }
    `;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: base64Image } }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return JSON.parse(data.choices[0].message.content);
}

async function addToGoogleTasks(item) {
    const token = localStorage.getItem('google_access_token');
    if (!token) {
        showToast("Please login again to connect Google Tasks.");
        return;
    }
    const taskPayload = {
        title: `Eat: ${item.item} 🍎`,
        notes: `Expires in ${item.spoil} days.\nSaved via FreshFirst.`,
        due: item.expiryDateObj.toISOString()
    };
    try {
        const response = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(taskPayload)
        });
        if (response.status === 401) {
            showToast("Session expired. Please re-login.");
            return;
        }
        if (response.ok) showToast(`✅ Added "${item.item}" to Google Tasks!`);
        else showToast("Failed to add task.");
    } catch (error) {
        showToast("Network Error.");
    }
}

// --- MODAL LOGIC ---
const modal = document.getElementById("itemModal");
const closeModal = document.getElementById("closeModal");
const modalTitle = document.getElementById("modalTitle");
const modalCategory = document.getElementById("modalCategory");
const modalBought = document.getElementById("modalBought");
const modalExpires = document.getElementById("modalExpires");
const modalDaysLeft = document.getElementById("modalDaysLeft");
const addToCalBtn = document.getElementById("addToCalBtn");
const editPerishBtn = document.getElementById("editPerishBtn");
const eatRemoveBtn = document.getElementById("deleteBtnModal");

function openModal(item, daysLeft) {
    if (!modal) return; // Exit if modal not found (donate.html)

    modalTitle.innerText = item.item;
    modalCategory.innerText = item.category;
    modalBought.innerText = item.date;
    modalExpires.innerText = formatDateReadable(item.expiryDateObj);
    modalDaysLeft.innerText = daysLeft;

    addToCalBtn.innerHTML = `
        <img src="https://upload.wikimedia.org/wikipedia/commons/5/5b/Google_Tasks_2021.svg" 
             alt="Tasks" 
             style="width: 20px; height: 20px; vertical-align: middle; margin-right: 8px;">
        Add Reminder
    `;
    addToCalBtn.onclick = () => addToGoogleTasks(item);
    
    editPerishBtn.onclick = () => {
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.style.visibility = 'hidden';
        dateInput.style.position = 'absolute';
        document.body.appendChild(dateInput);

        dateInput.onchange = () => {
            if (!dateInput.value) return;
            const parts = dateInput.value.split('-');
            const selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const diffTime = selectedDate - today;
            const daysNum = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (isNaN(daysNum) || daysNum < 0) {
                showToast("Please select a future date.");
                document.body.removeChild(dateInput);
                return;
            }

            const user = firebase.auth().currentUser;
            if (!user) return;

            firebase.firestore().collection('users').doc(user.uid)
                .collection('items').doc(item.id).update({ spoil: daysNum })
                .then(() => {
                    modal.classList.add("hidden");
                    showToast(`Updated! Item expires in ${daysNum} days.`);
                    document.body.removeChild(dateInput);
                })
                .catch((error) => {
                    console.error("Error", error);
                    document.body.removeChild(dateInput);
                });
        };
        try { dateInput.showPicker(); } 
        catch (err) { dateInput.style.visibility = 'visible'; dateInput.click(); dateInput.style.visibility = 'hidden'; }
    };

    eatRemoveBtn.onclick = () => {
        if (!confirm(`Mark ${item.item} as eaten?`)) return;
        const user = firebase.auth().currentUser;
        if (!user) return;
        firebase.firestore().collection('users').doc(user.uid)
            .collection('items').doc(item.id).delete()
            .then(() => {
                modal.classList.add("hidden");
                showToast("Yum! Item removed.");
            });
    }

    modal.classList.remove("hidden");
    
    // DONATE BUTTON TOGGLE
    const donateBtn = document.getElementById('donateBtn');
    if (donateBtn) {
        if (item.status === 'listed') {
            donateBtn.innerHTML = "Unlist";
            donateBtn.style.borderColor = "#d9534f";
            donateBtn.style.color = "#d9534f";
            donateBtn.onclick = () => unlistFromDonation(item);
        } else if (item.status === 'pending') {
            donateBtn.innerHTML = "Pending...";
            donateBtn.disabled = true;
            donateBtn.style.borderColor = "#F4B400";
            donateBtn.style.color = "#F4B400";
        } else {
            donateBtn.innerHTML = "Share";
            donateBtn.style.borderColor = "var(--hf-lime)";
            donateBtn.style.color = "var(--hf-green)";
            donateBtn.disabled = false;
            donateBtn.onclick = () => listForDonation(item);
        }
    }
}

if (closeModal) closeModal.onclick = () => modal.classList.add("hidden");
window.onclick = (event) => {
    if (event.target == modal) modal.classList.add("hidden");
}

// ------------------------------------------------
// CHEFBOT LOGIC
// ------------------------------------------------
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatWindow = document.getElementById('chatWindow');
const closeChat = document.getElementById('closeChat');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const chatMessages = document.getElementById('chatMessages');
let chatHistory = [];

if (chatToggleBtn) {
    chatToggleBtn.onclick = () => chatWindow.classList.remove('hidden');
    closeChat.onclick = () => chatWindow.classList.add('hidden');
    sendChatBtn.onclick = handleUserMessage;
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUserMessage();
    });
}

async function handleUserMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    addMessageToUI(text, 'user');
    chatInput.value = '';

    const pantryContext = allItemsData.map(item =>
        `- ${item.item} (${item.category}): Expires in ${item.spoil} days [ID: ${item.id}]`
    ).join('\n');

    const systemPrompt = `
    You are ChefBot. Current Pantry: ${pantryContext}. 
    GOAL: Suggest simple recipes for expiring items.
    If user eats an item, output: ^^^JSON {"action": "remove", "ids": ["ID"]} ^^^
    `;

    chatHistory.push({ role: "user", content: text });
    const loadingId = addMessageToUI("Thinking...", 'bot');

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, ...chatHistory.slice(-5)]
            })
        });

        const data = await response.json();
        const botReply = data.choices[0].message.content;
        document.getElementById(loadingId).remove();
        const cleanReply = extractAndExecuteActions(botReply);
        addMessageToUI(cleanReply, 'bot');
        chatHistory.push({ role: "assistant", content: cleanReply });

    } catch (error) {
        document.getElementById(loadingId).innerText = "❌ Error.";
    }
}

function addMessageToUI(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.innerText = text;
    div.id = 'msg-' + Date.now();
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div.id;
}

function extractAndExecuteActions(text) {
    const jsonRegex = /\^\^\^JSON([\s\S]*?)\^\^\^/;
    const match = text.match(jsonRegex);
    if (match) {
        try {
            const actionData = JSON.parse(match[1].trim());
            if (actionData.action === "remove" && actionData.ids) performAutoDelete(actionData.ids);
            return text.replace(jsonRegex, "").trim();
        } catch (e) { console.error(e); }
    }
    return text + "\n\n(AI suggestions may be inaccurate)";
}

async function performAutoDelete(ids) {
    const user = firebase.auth().currentUser;
    if (!user) return;
    const batch = firebase.firestore().batch();
    ids.forEach(id => {
        const docRef = firebase.firestore().collection('users').doc(user.uid).collection('items').doc(id);
        batch.delete(docRef);
    });
    try {
        await batch.commit();
        setTimeout(() => addMessageToUI("✅ Pantry updated!", 'bot'), 1000);
    } catch (e) { console.error(e); }
}

// ------------------------------------------------
// DONATION LOGIC (Shared & Unlist)
// ------------------------------------------------
async function listForDonation(item) {
    const user = firebase.auth().currentUser;
    if (!user) return;
    const location = prompt("🏠 Enter pickup location:");
    if (!location) return;
    const phone = prompt("📱 Enter contact phone:");
    if (!phone) return;

    const db = firebase.firestore();
    const batch = db.batch();
    const communityRef = db.collection('community_pantry').doc();
    batch.set(communityRef, {
        item: item.item,
        category: item.category,
        expiryDate: item.expiryDateObj.toISOString(),
        location: location,
        phone: phone,
        donorId: user.uid,
        donorName: user.displayName,
        donorEmail: user.email,
        originalItemId: item.id,
        claimStatus: 'available',
        postedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const privateRef = db.collection('users').doc(user.uid).collection('items').doc(item.id);
    batch.update(privateRef, { status: 'listed' });

    try {
        await batch.commit();
        showToast("Listed!");
        if (modal) modal.classList.add('hidden');
    } catch (e) { showToast("Error: " + e.message); }
}

async function unlistFromDonation(item) {
    const user = firebase.auth().currentUser;
    if (!user) return;
    if (!confirm("Unlist this item?")) return;

    const db = firebase.firestore();
    try {
        const publicQuery = await db.collection('community_pantry')
            .where('originalItemId', '==', item.id)
            .where('donorId', '==', user.uid).get();
        const batch = db.batch();
        publicQuery.forEach(doc => batch.delete(doc.ref));
        const privateRef = db.collection('users').doc(user.uid).collection('items').doc(item.id);
        batch.update(privateRef, { status: firebase.firestore.FieldValue.delete() });
        await batch.commit();
        showToast("Unlisted.");
        if (modal) modal.classList.add('hidden');
    } catch (e) { showToast("Error: " + e.message); }
}

// ------------------------------------------------
// 17. DONATION FEED PAGE LOGIC (donate.html)
// ------------------------------------------------
// This runs globally because 'donationGrid' is defined at the top
// ------------------------------------------------
// 17. DONATION FEED PAGE LOGIC (Fixed: Email + Descriptions + Hard Delete)
// ------------------------------------------------

// Only run this logic if we are on the donate page
if (donationGrid) {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();

    db.collection('community_pantry')
      .where('claimStatus', '==', 'available')
      .orderBy('postedAt', 'desc')
      .onSnapshot(snapshot => {
          donationGrid.innerHTML = '';
          
          if (snapshot.empty) {
              donationGrid.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; color:#999; padding:40px;">
                    <h3>No food available right now.</h3>
                    <p>Check back later or share something from your kitchen!</p>
                </div>`;
              return;
          }

          snapshot.forEach(doc => {
              renderPublicCard(doc.id, doc.data());
          });
      });
}

// A. RENDER CARD (Now includes Title, Location, Date)
function renderPublicCard(docId, data) {
    const card = document.createElement('div');
    card.className = 'card';
    // Add styling directly to ensure it looks good
    card.style.cssText = "background:white; padding:20px; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.1); display:flex; flex-direction:column; gap:10px;";
    
    const expDate = new Date(data.expiryDate).toLocaleDateString();

    // We pass ALL the data needed for email/deletion into the onclick arguments
    card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <h3 style="margin:0; color:#067A46; font-size:1.1rem;">${data.item}</h3>
              </div>
        
        <div style="color:#555; font-size:0.9rem;">
            <p style="margin:5px 0;"><strong>${data.location}</strong></p>
            <p style="margin:0; color:#888; font-size:0.8rem;">Expires: ${expDate}</p>
        </div>
        
        <button class="btn btn-primary" 
            onclick="claimItem('${docId}', '${data.item}', '${data.phone}', '${data.donorId}', '${data.originalItemId}', '${data.donorName}', '${data.donorEmail}', '${data.location}')" 
            style="width:100%; margin-top:auto; padding:10px;">
            Claim & Pickup
        </button>
    `;
    
    donationGrid.appendChild(card);
}

// B. CLAIM FUNCTION (Sends Email AND Deletes Item)
// We assign it to 'window' so the HTML onclick can see it
window.claimItem = async function(docId, itemName, phone, donorId, originalItemId, donorName, donorEmail, location) {
    
    // 1. Check Login
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
        showToast("Please login to claim items.");
        return;
    }

    const claimantName = prompt(`Enter your name to claim "${itemName}":`);
    if (!claimantName) return;

    // 2. SEND EMAIL (Background Task)
    const formData = new FormData();
    formData.append("itemName", itemName);
    formData.append("location", location);
    formData.append("donorName", donorName || "Neighbor");
    formData.append("donorEmail", donorEmail || "");
    formData.append("claimantName", claimantName);
    formData.append("claimantEmail", currentUser.email);

    // We use no-cors because Google Scripts don't return standard CORS headers
    fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        body: formData,
        mode: "no-cors"
    }).catch(e => console.log("Email trigger warning:", e));

    // 3. DELETE DATA (Hard Delete)
    const db = firebase.firestore();
    const batch = db.batch();

    // Delete Public Post
    const publicRef = db.collection('community_pantry').doc(docId);
    batch.delete(publicRef);

    // Delete Private Item (if linked)
    if (donorId && originalItemId) {
        const privateRef = db.collection('users').doc(donorId).collection('items').doc(originalItemId);
        batch.delete(privateRef);
    }

    try {
        await batch.commit();
        showToast(`SUCCESS! You claimed "${itemName}".\n\n1. Receipt emailed to you and the donor.\n2. Item removed from the website.\n3. Contact donor at: ${phone}`);
    } catch (e) {
        console.error("Claim Error:", e);
        showToast("Error claiming item.");
    }
};

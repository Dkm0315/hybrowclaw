<script setup>
import {computed, onMounted, reactive, ref} from "vue";

const visits = ref([]);
const busy = ref(false);
const error = ref("");
const deleteOpen = ref(false);
const path = ref(window.location.pathname);
const form = reactive({customer: "", scheduled_on: "", status: "Planned", notes: ""});

const newRoute = computed(() => path.value === "/operations/visits/new");
const recordName = computed(() => {
  const match = path.value.match(/^\/operations\/visits\/([^/]+)$/);
  return match && match[1] !== "new" ? decodeURIComponent(match[1]) : "";
});
const formRoute = computed(() => newRoute.value || Boolean(recordName.value));

function csrf() {
  return document.querySelector('meta[name="csrf-token"]')?.content || "";
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {Accept: "application/json", "Content-Type": "application/json", "X-Frappe-CSRF-Token": csrf(), ...(options.headers || {})},
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("request-failed");
  return body.data;
}

async function load() {
  busy.value = true;
  error.value = "";
  try {
    if (recordName.value) {
      Object.assign(form, await request(`/api/resource/Service Visit/${encodeURIComponent(recordName.value)}`));
    } else if (!newRoute.value) {
      const fields = encodeURIComponent(JSON.stringify(["name", "customer", "scheduled_on", "status", "modified"]));
      visits.value = await request(`/api/resource/Service Visit?fields=${fields}&order_by=modified%20desc&limit_page_length=50`);
    } else Object.assign(form, {customer: "", scheduled_on: "", status: "Planned", notes: ""});
  } catch (_error) {
    error.value = "This page could not load with your current access.";
  } finally {
    busy.value = false;
  }
}

function navigate(target) {
  window.history.pushState({}, "", target);
  path.value = target;
  load();
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const values = {customer: form.customer, scheduled_on: form.scheduled_on, status: form.status, notes: form.notes};
  try {
    const saved = recordName.value
      ? await request(`/api/resource/Service Visit/${encodeURIComponent(recordName.value)}`, {method: "PUT", body: JSON.stringify(values)})
      : await request("/api/resource/Service Visit", {method: "POST", body: JSON.stringify(values)});
    navigate(`/operations/visits/${encodeURIComponent(saved.name)}`);
  } catch (_error) {
    error.value = "The visit was not saved. Check your access and required values.";
  } finally {
    busy.value = false;
  }
}

function reviewDelete() {
  if (!recordName.value || busy.value) return;
  deleteOpen.value = true;
}

async function deleteVisit() {
  if (!recordName.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await request(`/api/resource/Service Visit/${encodeURIComponent(recordName.value)}`, {method: "DELETE"});
    deleteOpen.value = false;
    navigate("/operations/visits");
  } catch (_error) {
    error.value = "The visit was not deleted. Check your access and reload the record.";
  } finally {
    busy.value = false;
  }
}

window.addEventListener("popstate", () => { path.value = window.location.pathname; load(); });
onMounted(load);
</script>

<template>
  <div class="shell">
    <header><button class="brand" type="button" @click="navigate('/operations/visits')">Field Operations</button><span>Native Vue workspace</span></header>
    <section v-if="error" class="notice" role="alert">{{ error }}</section>
    <section v-if="formRoute" class="card form-card">
      <div class="title-row"><div><p class="eyebrow">Service Visit</p><h1>{{ recordName || 'New visit' }}</h1></div><button type="button" class="quiet" @click="navigate('/operations/visits')">Back to visits</button></div>
      <label>Customer<input v-model="form.customer" name="customer" aria-label="Customer" placeholder="Choose customer" required></label>
      <label>Scheduled On<input v-model="form.scheduled_on" name="scheduled_on" aria-label="Scheduled On" type="date" required></label>
      <label>Status<select v-model="form.status" name="status" aria-label="Status"><option>Planned</option><option>In Progress</option><option>Completed</option></select></label>
      <label>Notes<textarea v-model="form.notes" name="notes" aria-label="Notes" placeholder="Visit instructions"></textarea></label>
      <div class="actions"><span>{{ busy ? 'Working…' : 'Review every value before committing.' }}</span><div class="record-actions"><button v-if="recordName" type="button" class="danger" :disabled="busy" @click="reviewDelete">Delete</button><button type="button" class="primary" :disabled="busy" @click="save">{{ recordName ? 'Save' : 'Create' }}</button></div></div>
      <div v-if="deleteOpen" class="native-dialog-backdrop">
        <section class="native-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <p class="eyebrow">Native confirmation</p>
          <h2 id="delete-title">Delete Service Visit?</h2>
          <p>This will permanently delete <strong>{{ recordName }}</strong>.</p>
          <div class="record-actions"><button type="button" class="quiet" :disabled="busy" @click="deleteOpen = false">Cancel</button><button type="button" class="danger" :disabled="busy" @click="deleteVisit">Delete</button></div>
        </section>
      </div>
    </section>
    <section v-else class="card">
      <div class="title-row"><div><p class="eyebrow">Field Operations</p><h1>Service visits</h1></div><button type="button" class="primary" @click="navigate('/operations/visits/new')">Create</button></div>
      <p v-if="busy">Loading visits…</p>
      <button v-for="visit in visits" :key="visit.name" type="button" class="visit" @click="navigate(`/operations/visits/${encodeURIComponent(visit.name)}`)"><strong>{{ visit.customer }}</strong><span>{{ visit.scheduled_on }} · {{ visit.status }}</span></button>
      <p v-if="!busy && !visits.length">No service visits yet.</p>
    </section>
  </div>
</template>

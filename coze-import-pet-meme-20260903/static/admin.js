const adminForm = document.querySelector("#admin-form");
const adminPassword = document.querySelector("#admin-password");
const inviteProvider = document.querySelector("#invite-provider");
const inviteUses = document.querySelector("#invite-uses");
const inviteCount = document.querySelector("#invite-count");
const createInvite = document.querySelector("#create-invite");
const createdCode = document.querySelector("#created-code");
const copyCreatedCode = document.querySelector("#copy-created-code");
const inviteList = document.querySelector("#invite-list");
const adminStatus = document.querySelector("#admin-status");
const refreshInvites = document.querySelector("#refresh-invites");

const providerNames = {
  gemini: "Gemini",
  seedream: "Seedream",
};

let lastCreatedCodes = [];

function adminHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Admin-Password": adminPassword.value,
  };
}

async function readJsonResponse(response) {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "请求失败。");
  }
  return payload;
}

function inviteStateText(invite) {
  return invite.enabled ? "可用" : "已暂停";
}

function renderInvites(invites) {
  inviteList.textContent = "";
  if (!invites.length) {
    const empty = document.createElement("p");
    empty.className = "inline-status";
    empty.textContent = "暂无邀请码。";
    inviteList.append(empty);
    return;
  }

  invites.forEach((invite) => {
    const row = document.createElement("article");
    row.className = "invite-row";

    const details = document.createElement("div");
    details.className = "invite-details";
    const codeHint = document.createElement("strong");
    codeHint.textContent = invite.code_hint;
    const provider = document.createElement("span");
    provider.textContent = providerNames[invite.provider] || invite.provider;
    const remainingUses = document.createElement("span");
    remainingUses.textContent = `剩余 ${invite.remaining_uses} 积分`;
    const successfulUses = document.createElement("span");
    successfulUses.textContent = `成功生成 ${invite.successful_uses} 次`;
    const state = document.createElement("span");
    state.textContent = inviteStateText(invite);
    details.append(codeHint, provider, remainingUses, successfulUses, state);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = invite.enabled ? "暂停" : "恢复";
    button.addEventListener("click", async () => {
      button.disabled = true;
      adminStatus.textContent = invite.enabled ? "正在暂停邀请码..." : "正在恢复邀请码...";
      try {
        const response = await fetch(`/api/admin/invites/${invite.id}/toggle`, {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ enabled: !invite.enabled }),
        });
        const updated = await readJsonResponse(response);
        renderInvites(
          invites.map((item) => {
            if (item.id === updated.id) {
              return updated;
            }
            return item;
          })
        );
        adminStatus.textContent = updated.enabled ? "邀请码已恢复。" : "邀请码已暂停。";
      } catch (error) {
        adminStatus.textContent = error.message;
        button.disabled = false;
      }
    });

    row.append(details, button);
    inviteList.append(row);
  });
}

async function loadInvites() {
  adminStatus.textContent = "正在读取邀请码...";
  try {
    const response = await fetch("/api/admin/invites", {
      method: "GET",
      headers: { "X-Admin-Password": adminPassword.value },
    });
    const payload = await readJsonResponse(response);
    renderInvites(payload.invites);
    adminStatus.textContent = "邀请码列表已更新。";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
}

adminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createInvite.disabled = true;
  createdCode.textContent = "";
  copyCreatedCode.disabled = true;
  copyCreatedCode.textContent = "复制";
  lastCreatedCodes = [];
  
  const count = Number(inviteCount.value) || 1;
  adminStatus.textContent = count > 1 ? `正在生成 ${count} 个邀请码...` : "正在生成邀请码...";

  try {
    const response = await fetch("/api/admin/invites/batch", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        provider: inviteProvider.value,
        uses: Number(inviteUses.value),
        count: count,
      }),
    });
    const payload = await readJsonResponse(response);
    
    lastCreatedCodes = payload.codes || [];
    if (lastCreatedCodes.length === 1) {
      createdCode.textContent = lastCreatedCodes[0];
      copyCreatedCode.textContent = "复制";
    } else {
      createdCode.textContent = lastCreatedCodes.join("\n");
      createdCode.style.whiteSpace = "pre-line";
      copyCreatedCode.textContent = `复制全部 (${lastCreatedCodes.length})`;
    }
    
    copyCreatedCode.disabled = false;
    adminStatus.textContent = count > 1 ? `已生成 ${lastCreatedCodes.length} 个邀请码。` : "邀请码已生成。";
    await loadInvites();
  } catch (error) {
    adminStatus.textContent = error.message;
  } finally {
    createInvite.disabled = false;
  }
});

copyCreatedCode.addEventListener("click", async () => {
  const code = createdCode.textContent.trim();
  if (!code) {
    return;
  }
  try {
    await navigator.clipboard.writeText(code);
    copyCreatedCode.disabled = true;
    copyCreatedCode.textContent = lastCreatedCodes.length > 1 ? `已复制 (${lastCreatedCodes.length})` : "已复制";
    adminStatus.textContent = "新邀请码已复制。";
  } catch (error) {
    adminStatus.textContent = "复制失败，请手动选中邀请码。";
  }
});

refreshInvites.addEventListener("click", loadInvites);

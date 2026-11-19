const backupKeys = [STORAGE_KEY, DATE_KEY, COMPLETED_DAYS_KEY, DAY_PROGRESS_KEY, TIMER_MINUTES_KEY];
function backupMessage(message) {
  document.getElementById("backupStatus").textContent = message;
}
function makeBackup() {
  return {
    app: "habit-checker", version: 1, exportedAt: new Date().toISOString(),
    items: JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"),
    date: localStorage.getItem(DATE_KEY) || todayStr(),
    completedDays: loadCompletedDays(), dayProgress: loadDayProgress(),
    timerMinutes: Number(localStorage.getItem(TIMER_MINUTES_KEY) || 5)
  };
}
function validateBackup(data) {
  const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!data || data.app !== "habit-checker" || data.version !== 1 ||
      !validDate(data.date) || !Array.isArray(data.items) ||
      !Array.isArray(data.completedDays) || !data.completedDays.every(validDate) ||
      !data.dayProgress || typeof data.dayProgress !== "object" || Array.isArray(data.dayProgress) ||
      !Number.isInteger(data.timerMinutes) || data.timerMinutes < 1 || data.timerMinutes > 120) {
    throw new Error("習慣チェッカーの記録ファイルではありません。");
  }
  const ids = new Set();
  const items = data.items.map(item => {
    if (!item || !Number.isSafeInteger(item.id) || ids.has(item.id) ||
        typeof item.text !== "string" || !item.text.trim() ||
        typeof item.checked !== "boolean" ||
        (item.started !== undefined && typeof item.started !== "boolean")) {
      throw new Error("習慣データの形式が正しくありません。");
    }
    ids.add(item.id);
    return {id:item.id, text:item.text, checked:item.checked, started:!!(item.started || item.checked)};
  });
  for (const [date, percent] of Object.entries(data.dayProgress)) {
    if (!validDate(date) || !Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error("カレンダー記録の形式が正しくありません。");
    }
  }
  return {...data, items};
}
async function exportBackup() {
  try {
    const data = makeBackup();
    validateBackup(data);
    const file = new File([JSON.stringify(data, null, 2)], "habit-checker-" + todayStr() + ".json", {type:"application/json"});
    if (navigator.canShare && navigator.canShare({files:[file]})) {
      await navigator.share({files:[file], title:"習慣チェッカーの記録"});
      backupMessage("記録ファイルを共有しました。");
    } else {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      backupMessage("記録ファイルを書き出しました。");
    }
  } catch (error) {
    if (error.name !== "AbortError") backupMessage("書き出せませんでした: " + error.message);
  }
}
function applyBackup(data) {
  const values = [JSON.stringify(data.items), data.date, JSON.stringify(data.completedDays),
    JSON.stringify(data.dayProgress), String(data.timerMinutes)];
  const before = backupKeys.map(key => localStorage.getItem(key));
  // Keep the receiving device's previous data before replacing its records.
  localStorage.setItem("habit_checker_before_import", JSON.stringify({keys:backupKeys, values:before}));
  try {
    backupKeys.forEach((key, index) => localStorage.setItem(key, values[index]));
  } catch (error) {
    backupKeys.forEach((key, index) => {
      if (before[index] === null) localStorage.removeItem(key);
      else localStorage.setItem(key, before[index]);
    });
    throw error;
  }
}
async function importBackup(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    if (timerRunning || activeHabitId !== null) throw new Error("タイマーを閉じてから読み込んでください。");
    if (file.size > 5 * 1024 * 1024) throw new Error("ファイルが大きすぎます。");
    const data = validateBackup(JSON.parse(await file.text()));
    const days = new Set([...data.completedDays, ...Object.keys(data.dayProgress)]).size;
    if (!confirm("習慣 " + data.items.length + "件・記録 " + days + "日分を読み込みます。\nこのブラウザの記録は置き換わります。続けますか？")) return;
    applyBackup(data);
    render();
    backupMessage("記録を読み込みました。");
    checkMonthlyBackup();
  } catch (error) {
    backupMessage("読み込めませんでした: " + error.message);
  } finally {
    input.value = "";
  }
}
const MONTHLY_CONFIRMED_KEY = "habit_checker_monthly_backup_confirmed";
function monthlyBackupDue(data, now, confirmed) {
  const month = dateStr(now).slice(0, 7);
  const monthEnd = now.getDate() === new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const target = monthEnd ? month : dateStr(new Date(now.getFullYear(), now.getMonth(), 0)).slice(0, 7);
  const dates = [...Object.keys(data.dayProgress), ...data.completedDays];
  if (data.items.length) dates.push(data.date);
  if (!dates.some(date => date.slice(0, 7) <= target)) return null;
  return confirmed && confirmed >= target ? null : target;
}
let monthlyPending = null;
let monthlyAttempted = null;
function downloadMonthlyBackup() {
  try {
    const data = makeBackup();
    validateBackup(data);
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "habit-checker-monthly-" + monthlyPending + "-" + todayStr() + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    document.getElementById("monthlyBackupText").textContent =
      monthlyPending + " 月次バックアップ：ダウンロード要求済み・保存未確認";
    document.getElementById("monthlyBackupConfirm").disabled = false;
  } catch (error) {
    backupMessage("月次バックアップを書き出せませんでした: " + error.message);
  }
}
function checkMonthlyBackup() {
  if (document.visibilityState === "hidden") return;
  try {
    const due = monthlyBackupDue(makeBackup(), new Date(), localStorage.getItem(MONTHLY_CONFIRMED_KEY));
    const panel = document.getElementById("monthlyBackup");
    if (!due) { panel.hidden = true; monthlyPending = null; return; }
    panel.hidden = false;
    if (monthlyPending !== due) {
      monthlyPending = due;
      document.getElementById("monthlyBackupText").textContent = due + " 月次バックアップ：未保存";
      document.getElementById("monthlyBackupConfirm").disabled = true;
    }
    if (monthlyAttempted !== due) {
      monthlyAttempted = due;
      downloadMonthlyBackup();
    }
  } catch (error) {
    backupMessage("月次バックアップを確認できませんでした: " + error.message);
  }
}
function confirmMonthlyBackup() {
  if (!monthlyPending || !confirm("ダウンロード先に記録ファイルが保存されていることを確認しましたか？")) return;
  try {
    localStorage.setItem(MONTHLY_CONFIRMED_KEY, monthlyPending);
    document.getElementById("monthlyBackup").hidden = true;
    backupMessage(monthlyPending + " 月次バックアップ：保存確認済み");
    monthlyPending = null;
  } catch (error) {
    backupMessage("保存確認を記録できませんでした: " + error.message);
  }
}
const monthlyPanel = document.createElement("section");
monthlyPanel.id = "monthlyBackup";
monthlyPanel.hidden = true;
monthlyPanel.style.cssText = "margin:12px 0;padding:12px 0;border-block:1px solid var(--line)";
const monthlyText = document.createElement("div");
monthlyText.id = "monthlyBackupText";
monthlyText.setAttribute("role", "status");
monthlyText.style.cssText = "font-size:13px;overflow-wrap:anywhere;margin-bottom:8px";
const monthlyActions = document.createElement("div");
monthlyActions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
const monthlyRetry = document.createElement("button");
monthlyRetry.type = "button";
monthlyRetry.className = "timer-action";
monthlyRetry.textContent = "バックアップを保存";
monthlyRetry.onclick = downloadMonthlyBackup;
const monthlyConfirm = document.createElement("button");
monthlyConfirm.type = "button";
monthlyConfirm.id = "monthlyBackupConfirm";
monthlyConfirm.className = "timer-action";
monthlyConfirm.textContent = "保存できた";
monthlyConfirm.onclick = confirmMonthlyBackup;
monthlyActions.append(monthlyRetry, monthlyConfirm);
monthlyPanel.append(monthlyText, monthlyActions);
document.querySelector(".progress-wrap").after(monthlyPanel);
checkMonthlyBackup();
document.addEventListener("visibilitychange", checkMonthlyBackup);
window.addEventListener("focus", checkMonthlyBackup);
setInterval(checkMonthlyBackup, 60000);

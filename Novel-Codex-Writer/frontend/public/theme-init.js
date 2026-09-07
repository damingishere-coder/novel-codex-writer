// Runs before the application and styles load, including on a cold refresh.
(() => {
  let preference;
  try { preference = localStorage.getItem("novel-theme"); } catch { /* Optional storage. */ }
  const dark = preference === "dark" || (preference !== "light" && preference !== "dark" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();

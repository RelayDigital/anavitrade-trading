(function () {
  try {
    var theme = localStorage.getItem("theme");
    if (theme === "dark" || theme === null) {
      document.documentElement.classList.add("dark");
    }
  } catch (_) {}
})();

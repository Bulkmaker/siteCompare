(function () {
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  document.addEventListener("mouseover", function (e) {
    const ico = e.target.closest(".ico");
    if (ico && (ico.dataset.old || ico.dataset.new)) {
      const oldVal = ico.dataset.old || "";
      const newVal = ico.dataset.new || "";
      tooltip.innerHTML =
        `<div class="old">OLD: ${oldVal}</div>` +
        `<div class="new">NEW: ${newVal}</div>`;
      tooltip.style.display = "block";
    }
  });

  document.addEventListener("mousemove", function (e) {
    if (tooltip.style.display === "block") {
      tooltip.style.left = e.pageX + 12 + "px";
      tooltip.style.top = e.pageY + 12 + "px";
    }
  });

  document.addEventListener("mouseout", function (e) {
    const ico = e.target.closest(".ico");
    if (ico && (ico.dataset.old || ico.dataset.new)) {
      tooltip.style.display = "none";
    }
  });
})();

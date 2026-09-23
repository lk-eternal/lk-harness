(function () {
  var data = JSON.parse(document.getElementById("diff-data").textContent);
  var panel = document.getElementById("file-panel");
  var ph = document.getElementById("diff-placeholder");
  var sc = document.getElementById("diff-scroll");
  var fileList = document.getElementById("file-list");
  var currentIndex = -1;
  var cacheKey = "";
  var changeFocusIdx = -1;
  var hScrollRail = null;
  var hScrollInner = null;
  var hScrollSyncing = false;
  var diffPane = document.querySelector(".diff-pane");
  var diffViewport = document.querySelector(".diff-viewport");

  function mobile() { return window.matchMedia("(max-width:768px)").matches; }
  function viewMode() { return document.body.getAttribute("data-view") || "diff"; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function diffTextFor(file) {
    if (viewMode() === "full" && file.diffFull) return file.diffFull;
    return file.diffCompact || file.diffFull || "";
  }

  function d2hConfig() {
    return {
      drawFileList: false,
      matching: "lines",
      outputFormat: mobile() ? "line-by-line" : "side-by-side",
      synchronisedScroll: !mobile(),
      highlight: true,
      colorScheme: "dark",
    };
  }

  function renderFile(i, force) {
    var file = data.files[i];
    var view = viewMode();
    var key = i + "|" + view + "|" + (mobile() ? "m" : "d");
    if (!force && key === cacheKey && panel.firstChild) return;
    cacheKey = key;
    changeFocusIdx = -1;
    panel.innerHTML = "";
    var art = el("article", "file-view d2h-file-view");
    var hdr = el("header", "diff-file-header");
    hdr.appendChild(el("h2", null, file.path));
    art.appendChild(hdr);
    var mount = el("div", "d2h-mount");
    art.appendChild(mount);
    panel.appendChild(art);
    var text = diffTextFor(file);
    if (text && typeof Diff2HtmlUI !== "undefined") {
      var ui = new Diff2HtmlUI(mount, text, d2hConfig());
      ui.draw();
    } else {
      mount.textContent = text ? "（无 diff 文本）" : "（空 diff）";
    }
    clearChangeFocus();
    updateNavButtons();
    requestAnimationFrame(updateHScrollRail);
  }

  /** diff2html 并排横向滚在 .d2h-file-side-diff；逐行在 .d2h-file-diff */
  function hScrollTargets() {
    var mount = panel.querySelector(".d2h-mount");
    if (!mount) return [];
    var sides = mount.querySelectorAll(".d2h-file-side-diff");
    if (sides.length) return Array.prototype.slice.call(sides);
    var fileDiff = mount.querySelector(".d2h-file-diff");
    return fileDiff ? [fileDiff] : [];
  }

  function syncHScrollFrom(source, x) {
    hScrollTargets().forEach(function (t) {
      if (t !== source) t.scrollLeft = x;
    });
  }

  function ensureHScrollRail() {
    if (hScrollRail || !diffViewport) return;
    hScrollRail = el("div", "diff-hscroll-rail");
    hScrollRail.setAttribute("hidden", "");
    hScrollInner = el("div", "diff-hscroll-inner");
    hScrollRail.appendChild(hScrollInner);
    hScrollRail.addEventListener("scroll", function () {
      if (hScrollSyncing) return;
      hScrollSyncing = true;
      var x = hScrollRail.scrollLeft;
      syncHScrollFrom(hScrollRail, x);
      hScrollSyncing = false;
    });
    diffViewport.appendChild(hScrollRail);
  }

  function bindHScrollTargets() {
    hScrollTargets().forEach(function (t) {
      if (t._lkHScrollBound) return;
      t._lkHScrollBound = true;
      t.addEventListener("scroll", function () {
        if (hScrollSyncing) return;
        if (!mobile() && hScrollRail && !hScrollRail.hasAttribute("hidden")) return;
        hScrollSyncing = true;
        syncHScrollFrom(t, t.scrollLeft);
        hScrollSyncing = false;
      });
    });
  }

  function updateHScrollRail() {
    ensureHScrollRail();
    if (!hScrollRail) return;
    bindHScrollTargets();
    var targets = hScrollTargets();
    if (mobile()) {
      hScrollRail.setAttribute("hidden", "");
      if (diffPane) diffPane.classList.remove("diff-hscroll-active");
      return;
    }
    var overflow = 0;
    targets.forEach(function (t) {
      overflow = Math.max(overflow, t.scrollWidth - t.clientWidth);
    });
    if (overflow <= 0) {
      hScrollRail.setAttribute("hidden", "");
      if (diffPane) diffPane.classList.remove("diff-hscroll-active");
      return;
    }
    hScrollRail.removeAttribute("hidden");
    if (diffPane) diffPane.classList.add("diff-hscroll-active");
    hScrollInner.style.width = (hScrollRail.clientWidth + overflow) + "px";
    var x = targets[0] ? targets[0].scrollLeft : 0;
    hScrollSyncing = true;
    hScrollRail.scrollLeft = x;
    syncHScrollFrom(null, x);
    hScrollSyncing = false;
  }

  function isChangeRow(tr) {
    if (!tr || tr.querySelector("td.d2h-info")) return false;
    return !!tr.querySelector("td.d2h-del, td.d2h-ins");
  }

  function mergeChangeRegions(isChangeAt) {
    var regions = [];
    var inRegion = false;
    var start = null;
    for (var i = 0; i < isChangeAt.length; i++) {
      if (isChangeAt[i]) {
        if (!inRegion) {
          inRegion = true;
          start = i;
        }
      } else if (inRegion) {
        regions.push(start);
        inRegion = false;
        start = null;
      }
    }
    if (inRegion) regions.push(start);
    return regions;
  }

  /** 并排：左右表按行对齐后合并连续变动（单表 query 会把右表当成新区域） */
  function changeRegions() {
    var sides = panel.querySelectorAll(".d2h-file-side-diff");
    if (sides.length >= 2) {
      var leftRows = sides[0].querySelectorAll("tbody tr");
      var rightRows = sides[1].querySelectorAll("tbody tr");
      var n = Math.max(leftRows.length, rightRows.length);
      var flags = [];
      var rowAt = [];
      for (var i = 0; i < n; i++) {
        var lr = leftRows[i];
        var rr = rightRows[i];
        var ch = isChangeRow(lr) || isChangeRow(rr);
        flags.push(ch);
        rowAt.push((lr && isChangeRow(lr)) ? lr : rr);
      }
      return mergeChangeRegions(flags).map(function (idx) { return rowAt[idx]; });
    }
    var rows = panel.querySelectorAll(".d2h-diff-table tbody tr");
    var flags2 = [];
    var rowAt2 = [];
    rows.forEach(function (tr) {
      flags2.push(isChangeRow(tr));
      rowAt2.push(tr);
    });
    return mergeChangeRegions(flags2).map(function (idx) { return rowAt2[idx]; });
  }

  function clearChangeFocus() {
    panel.querySelectorAll("tr.row-change-focus").forEach(function (r) {
      r.classList.remove("row-change-focus");
    });
  }

  function focusChangeRow(row) {
    clearChangeFocus();
    if (!row) return;
    var sides = panel.querySelectorAll(".d2h-file-side-diff");
    if (sides.length >= 2) {
      var leftRows = sides[0].querySelectorAll("tbody tr");
      var rightRows = sides[1].querySelectorAll("tbody tr");
      for (var i = 0; i < leftRows.length; i++) {
        if (leftRows[i] === row || rightRows[i] === row) {
          if (isChangeRow(leftRows[i])) leftRows[i].classList.add("row-change-focus");
          if (rightRows[i] && isChangeRow(rightRows[i])) rightRows[i].classList.add("row-change-focus");
          return;
        }
      }
    }
    row.classList.add("row-change-focus");
  }

  function scrollToChangeRow(row) {
    if (!row || !sc) return;
    focusChangeRow(row);
    var rowRect = row.getBoundingClientRect();
    var scRect = sc.getBoundingClientRect();
    var target = sc.scrollTop + (rowRect.top - scRect.top) - sc.clientHeight * 0.35;
    sc.scrollTo({ top: Math.max(0, target), behavior: mobile() ? "auto" : "smooth" });
  }

  function scrollToFirstChange() {
    var regs = changeRegions();
    changeFocusIdx = regs.length ? 0 : -1;
    scrollToChangeRow(regs[0]);
    updateNavButtons();
  }

  function scrollToLastChange() {
    var regs = changeRegions();
    changeFocusIdx = regs.length ? regs.length - 1 : -1;
    scrollToChangeRow(regs[regs.length - 1]);
    updateNavButtons();
  }

  function gotoChange(delta) {
    var fileCount = data.files.length;
    var regs = changeRegions();
    if (!regs.length) {
      if (fileCount <= 1) return;
      if (delta > 0) gotoFile(1, true);
      else gotoFile(-1, "last");
      return;
    }
    if (changeFocusIdx < 0) {
      changeFocusIdx = delta > 0 ? 0 : regs.length - 1;
      scrollToChangeRow(regs[changeFocusIdx]);
      updateNavButtons();
      return;
    }
    var nextIdx = changeFocusIdx + delta;
    if (nextIdx >= regs.length) {
      if (fileCount <= 1) return;
      gotoFile(1, true);
      return;
    }
    if (nextIdx < 0) {
      if (fileCount <= 1) return;
      gotoFile(-1, "last");
      return;
    }
    changeFocusIdx = nextIdx;
    scrollToChangeRow(regs[changeFocusIdx]);
    updateNavButtons();
  }

  function updateNavButtons() {
    var n = data.files.length;
    var regs = changeRegions();
    document.getElementById("nav-prev-file").disabled = n <= 1;
    document.getElementById("nav-next-file").disabled = n <= 1;
    document.getElementById("nav-prev-change").disabled = !regs.length;
    document.getElementById("nav-next-change").disabled = !regs.length;
  }

  function gotoFile(delta, changeJump) {
    var n = data.files.length;
    if (n <= 1) return;
    var next = (currentIndex + delta + n) % n;
    show(next, changeJump);
  }

  function fileButton(file, idx) {
    var parts = file.path.split("/");
    var name = parts.pop();
    var dir = parts.join("/");
    var b = el("button", "file-item");
    b.type = "button";
    b.setAttribute("data-index", String(idx));
    b.appendChild(el("span", "file-name", name));
    b.appendChild(el("span", "file-dir", dir));
    var st = el("span", "file-stats");
    st.appendChild(el("span", "stat-add", "+" + file.add));
    st.appendChild(el("span", "stat-del", "-" + file.del));
    b.appendChild(st);
    b.addEventListener("click", function () { show(idx); });
    return b;
  }

  function show(i, changeJump) {
    i = Number(i);
    currentIndex = i;
    ph.setAttribute("hidden", "");
    sc.removeAttribute("hidden");
    document.getElementById("diff-toolbar").removeAttribute("hidden");
    cacheKey = "";
    renderFile(i, true);
    fileList.querySelectorAll(".file-item").forEach(function (b) {
      b.classList.toggle("active", Number(b.getAttribute("data-index")) === i);
    });
    var picker = document.getElementById("file-picker-btn");
    var f = data.files[i];
    if (picker && f) picker.textContent = f.path.split("/").pop();
    sc.scrollTop = 0;
    if (changeJump === true) requestAnimationFrame(scrollToFirstChange);
    else if (changeJump === "last") requestAnimationFrame(scrollToLastChange);
    else updateNavButtons();
  }

  function initMeta() {
    document.getElementById("meta-base").textContent = data.baseLabel;
    document.getElementById("meta-head").textContent = data.headLabel;
    var n = data.files.length;
    var nc = (data.commits || []).length;
    document.getElementById("meta-count").textContent = n + " 个文件 · " + nc + " 提交";
    document.getElementById("sidebar-head").textContent = "变更文件 (" + n + ")";
    document.getElementById("drawer-head").textContent = "变更文件 (" + n + ")";
    document.getElementById("meta-stat").textContent = data.stat || "";
    var ul = document.getElementById("meta-commits");
    ul.innerHTML = "";
    (data.commits || []).forEach(function (c) {
      var li = document.createElement("li");
      var code = document.createElement("code");
      code.textContent = c;
      li.appendChild(code);
      ul.appendChild(li);
    });
  }

  function buildLists() {
    fileList.innerHTML = "";
    data.files.forEach(function (f, i) { fileList.appendChild(fileButton(f, i)); });
  }

  document.getElementById("view-diff").addEventListener("click", function () {
    document.body.setAttribute("data-view", "diff");
    document.getElementById("view-diff").setAttribute("aria-pressed", "true");
    document.getElementById("view-full").setAttribute("aria-pressed", "false");
    cacheKey = "";
    if (currentIndex >= 0) renderFile(currentIndex, true);
  });
  document.getElementById("view-full").addEventListener("click", function () {
    document.body.setAttribute("data-view", "full");
    document.getElementById("view-diff").setAttribute("aria-pressed", "false");
    document.getElementById("view-full").setAttribute("aria-pressed", "true");
    cacheKey = "";
    if (currentIndex >= 0) renderFile(currentIndex, true);
  });
  document.getElementById("nav-prev-file").addEventListener("click", function () { gotoFile(-1, true); });
  document.getElementById("nav-next-file").addEventListener("click", function () { gotoFile(1, true); });
  document.getElementById("nav-prev-change").addEventListener("click", function () { gotoChange(-1); });
  document.getElementById("nav-next-change").addEventListener("click", function () { gotoChange(1); });
  document.getElementById("meta-toggle").addEventListener("click", function () {
    var ex = document.getElementById("meta-extra");
    var o = ex.hasAttribute("hidden");
    if (o) ex.removeAttribute("hidden"); else ex.setAttribute("hidden", "");
    this.textContent = o ? "收起详情" : "提交与统计";
  });
  var drawer = document.getElementById("file-drawer");
  var backdrop = document.getElementById("drawer-backdrop");
  document.getElementById("file-picker-btn").addEventListener("click", function () {
    var dl = document.getElementById("file-list-drawer");
    dl.innerHTML = "";
    data.files.forEach(function (f, i) {
      var c = fileButton(f, i);
      c.addEventListener("click", function () {
        show(i);
        drawer.classList.remove("open");
        backdrop.classList.remove("open");
        drawer.setAttribute("hidden", "");
        backdrop.setAttribute("hidden", "");
      });
      dl.appendChild(c);
    });
    drawer.removeAttribute("hidden");
    backdrop.removeAttribute("hidden");
    requestAnimationFrame(function () { drawer.classList.add("open"); backdrop.classList.add("open"); });
  });
  document.getElementById("drawer-close").addEventListener("click", function () {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    setTimeout(function () { drawer.setAttribute("hidden", ""); backdrop.setAttribute("hidden", ""); }, 260);
  });
  backdrop.addEventListener("click", function () {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    setTimeout(function () { drawer.setAttribute("hidden", ""); backdrop.setAttribute("hidden", ""); }, 260);
  });
  window.matchMedia("(max-width:768px)").addEventListener("change", function () {
    cacheKey = "";
    if (currentIndex >= 0) renderFile(currentIndex, true);
  });
  window.addEventListener("resize", function () {
    if (currentIndex >= 0) updateHScrollRail();
  });

  initMeta();
  buildLists();
  if (data.files.length) show(0);
  else ph.textContent = "暂无变更文件";
})();

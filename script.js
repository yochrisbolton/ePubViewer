"use strict";

// TODO:
// - change link color
// - search needs to go right to the search result
// - menu icon in sidebar needs to be changed (x button?)

function isRavenDisabled() {
    try {
        if (typeof disableRaven !== 'undefined' && disableRaven) return true;
        if (typeof window.disableRaven !== 'undefined' && window.disableRaven) return true;
        return false;
    } catch (ex) {
        return false;
    }
}

window.onerror = function (msg, url, line, column, err) {
    if (msg.indexOf("Permission denied") > -1) return;
    if (msg.indexOf("Object expected") > -1 && url.indexOf("epub") > -1) return;
    document.querySelector(".app .error").classList.remove("hidden");
    document.querySelector(".app .error .error-title").innerHTML = "Error";
    document.querySelector(".app .error .error-description").innerHTML = "Please try reloading the page or using a different browser (Chrome or Firefox), and if the error still persists, <a href=\"https://github.com/pgaskin/ePubViewer/issues\">report an issue</a>.";
    document.querySelector(".app .error .error-info").innerHTML = msg;
    document.querySelector(".app .error .error-dump").innerHTML = JSON.stringify({
        error: err.toString(),
        stack: err.stack,
        msg: msg,
        url: url,
        line: line,
        column: column,
    });
    try {
        if (!isRavenDisabled()) Raven.captureException(err);
    } catch (err) {}
};

let App = function (el) {
    this.ael = el;
    this.state = {};
    this.doReset();

    document.body.addEventListener("keyup", this.onKeyUp.bind(this));

    this.qsa(".tab-list .item").forEach(el => el.addEventListener("click", this.onTabClick.bind(this, el.dataset.tab)));
    this.qs(".sidebar .search-bar .search-box").addEventListener("keydown", event => {
        if (event.keyCode == 13) this.qs(".sidebar .search-bar .search-button").click();
    });
    this.qs(".sidebar .search-bar .search-button").addEventListener("click", this.onSearchClick.bind(this));
    this.qsa(".chips[data-chips]").forEach(el => {
        Array.from(el.querySelectorAll(".chip[data-value]")).forEach(cel => cel.addEventListener("click", event => {
            this.setChipActive(el.dataset.chips, cel.dataset.value);
        }));
    });
    this.qs("button.prev").addEventListener("click", () => {
        if (!this.state.enable_navigation) return;
        this.state.rendition.prev();
    });
    this.qs("button.next").addEventListener("click", () => {
        if (!this.state.enable_navigation) return;
        this.state.rendition.next();
    });

    try {
        this.qs(".bar .loc").style.cursor = "pointer";
        this.qs(".bar .loc").addEventListener("click", event => {
            try {
                let answer = prompt(`Location to go to (up to ${this.state.book.locations.length()})?`, this.state.rendition.currentLocation().start.location);
                if (!answer) return;
                answer = answer.trim();
                if (answer === "") return;

                let parsed = parseInt(answer, 10);
                if (isNaN(parsed) || parsed < 0) throw new Error("Invalid location: not a positive integer");
                if (parsed > this.state.book.locations.length()) throw new Error("Invalid location");

                let cfi = this.state.book.locations.cfiFromLocation(parsed);
                if (cfi === -1) throw new Error("Invalid location");

                this.state.rendition.display(cfi);
            } catch (err) {
                alert(err.toString());
            }
        });
    } catch (err) {
        this.fatal("error attaching event handlers for location go to", err);
        throw err;
    }

    this.doTab("toc");

    try {
        this.loadSettingsFromStorage();
    } catch (err) {
        this.fatal("error loading settings", err);
        throw err;
    }
    this.applyTheme();
};

App.prototype.doBook = function (url, opts) {
    this.qs(".book").innerHTML = "Loading";

    this.state.enable_navigation = true;

    opts = opts || {
        encoding: "epub"
    };
    console.log("doBook", url, opts);
    this.doReset();

    try {
        this.state.book = ePub(url, opts);
        this.qs(".book").innerHTML = "";

        let renditionOptions = {};
        if (this.getChipActive("vertical-scroll") === "true") {
            renditionOptions.flow = "scrolled-doc";
        }

        this.state.rendition = this.state.book.renderTo(this.qs(".book"), renditionOptions);
    } catch (err) {
        this.fatal("error loading book", err);
        throw err;
    }

    this.state.book.ready.then(this.onBookReady.bind(this)).catch(this.fatal.bind(this, "error loading book"));

    this.state.book.loaded.navigation.then(this.onNavigationLoaded.bind(this)).catch(this.fatal.bind(this, "error loading toc"));
    this.state.book.loaded.metadata.then(this.onBookMetadataLoaded.bind(this)).catch(this.fatal.bind(this, "error loading metadata"));
    this.state.book.loaded.cover.then(this.onBookCoverLoaded.bind(this)).catch(this.fatal.bind(this, "error loading cover"));

    this.state.rendition.hooks.content.register(this.applyTheme.bind(this));
    this.state.rendition.hooks.content.register(this.loadFonts.bind(this));

    this.state.rendition.on("relocated", this.onRenditionRelocated.bind(this));
    this.state.rendition.on("keyup", this.onKeyUp.bind(this));
    this.state.rendition.on("displayed", this.onRenditionDisplayedTouchSwipe.bind(this));
    this.state.rendition.on("relocated", this.onRenditionRelocatedUpdateIndicators.bind(this));
    this.state.rendition.on("relocated", this.onRenditionRelocatedSavePos.bind(this));
    this.state.rendition.on("started", this.onRenditionStartedRestorePos.bind(this));
    this.state.rendition.on("displayError", this.fatal.bind(this, "error rendering book"));

    if (this.getChipActive("vertical-scroll") === "true") {
        this.state.rendition.on("displayed", this.attachScrollListener.bind(this));
    }

    window.addEventListener("enable_navigation", () => {
        this.state.enable_navigation = true;
        this.initialSetup();
    });

    window.addEventListener("disable_navigation", () => {
        this.state.enable_navigation = false;
    });

// Ensuring that loadBookmarks is called only after the rendition is ready
    this.state.book.ready.then(() => {
        const storedPos = localStorage.getItem(`${this.state.book.key()}:pos`);
        if (storedPos) {
            this.state.rendition.display(storedPos).then(() => {
                this.loadBookmarks();  // Call loadBookmarks after displaying the stored position
            });
        } else {
            this.state.rendition.display().then(() => {
                this.loadBookmarks();  // Call loadBookmarks after the initial display
            });
        }
    }).catch(this.fatal.bind(this, "error loading book"));

    if (this.state.dictInterval) window.clearInterval(this.state.dictInterval);
    this.state.dictInterval = window.setInterval(this.checkDictionary.bind(this), 50);
    this.doDictionary(null);
};

App.prototype.initialSetup = function() {
    const currentLocation = this.state.rendition.currentLocation();

    if (currentLocation && currentLocation.start) {
        this.state.rendition.reportLocation();
    } else {
        this.state.rendition.display().then(() => {
            this.state.rendition.reportLocation();
        }).catch(err => {
            this.fatal("error during initial setup", err);
        });
    }

    this.updateUI();
};

App.prototype.updateUI = function() {
    const currentLocation = this.state.rendition.currentLocation();
    if (currentLocation && currentLocation.start) {
        this.onRenditionRelocatedUpdateIndicators(currentLocation);
    }
};

App.prototype.attachScrollListener = function () {
    const scrollableEl = this.qs(".book .epub-container");
    if (scrollableEl) {
        scrollableEl.addEventListener("scroll", this.onBookScroll.bind(this, scrollableEl));
    }
};

App.prototype.onBookScroll = function (scrollableEl) {
    if (scrollableEl.scrollTop + scrollableEl.clientHeight >= scrollableEl.scrollHeight - 100) {
        // this.state.rendition.next();
    }
};

App.prototype.reloadBook = function () {
    if (this.state.book) {
        const currentLocation = this.state.rendition.currentLocation();
        this.doBook(this.state.book.url, this.state.book.options);
        if (currentLocation) {
            this.state.rendition.display(currentLocation.start.cfi);
        }
    }
};

App.prototype.loadSettingsFromStorage = function () {
    ["theme", "font", "font-size", "line-spacing", "margin", "progress", "vertical-scroll"].forEach(container => this.restoreChipActive(container));
};

App.prototype.restoreChipActive = function (container) {
    let v = localStorage.getItem(`ePubViewer:${container}`);
    if (v) return this.setChipActive(container, v);
    this.setDefaultChipActive(container);
};

App.prototype.setDefaultChipActive = function (container) {
    let el = this.qs(`.chips[data-chips='${container}']`).querySelector(".chip[data-default]");
    this.setChipActive(container, el.dataset.value);
    return el.dataset.value;
};

App.prototype.setChipActive = function (container, value) {
    Array.from(this.qs(`.chips[data-chips='${container}']`).querySelectorAll(".chip[data-value]")).forEach(el => {
        el.classList[el.dataset.value === value ? "add" : "remove"]("active");
    });
    localStorage.setItem(`ePubViewer:${container}`, value);
    if (container === "vertical-scroll") {
        this.reloadBook();
    } else {
        this.applyTheme();
        if (this.state.rendition && this.state.rendition.location) this.onRenditionRelocatedUpdateIndicators(this.state.rendition.location);
    }
    return value;
};

App.prototype.getChipActive = function (container) {
    let el = this.qs(`.chips[data-chips='${container}']`).querySelector(".chip.active[data-value]");
    if (!el) return this.qs(`.chips[data-chips='${container}']`).querySelector(".chip[data-default]");
    return el.dataset.value;
};

App.prototype.doOpenBook = function () {
    var fi = document.createElement("input");
    fi.setAttribute("accept", "application/epub+zip");
    fi.style.display = "none";
    fi.type = "file";
    fi.onchange = event => {
        var reader = new FileReader();
        reader.addEventListener("load", () => {
            var arr = (new Uint8Array(reader.result)).subarray(0, 2);
            var header = "";
            for (var i = 0; i < arr.length; i++) {
                header += arr[i].toString(16);
            }
            if (header == "504b") {
                this.doBook(reader.result, {
                    encoding: "binary"
                });
            } else {
                this.fatal("invalid file", "not an epub book");
            }
        }, false);
        if (fi.files[0]) {
            reader.readAsArrayBuffer(fi.files[0]);
        }
    };
    document.body.appendChild(fi);
    fi.click();
};

App.prototype.fatal = function (msg, err, usersFault) {
    console.error(msg, err);
    document.querySelector(".app .error").classList.remove("hidden");
    document.querySelector(".app .error .error-title").innerHTML = "Error";
    document.querySelector(".app .error .error-description").innerHTML = usersFault ? "" : "Please try reloading the page or using a different browser, and if the error still persists, <a href=\"https://github.com/pgaskin/ePubViewer/issues\">report an issue</a>.";
    document.querySelector(".app .error .error-info").innerHTML = msg + ": " + err.toString();
    document.querySelector(".app .error .error-dump").innerHTML = JSON.stringify({
        error: err.toString(),
        stack: err.stack
    });
    try {
        if (!isRavenDisabled()) if (!usersFault) Raven.captureException(err);
    } catch (err) {}
};

App.prototype.doReset = function () {
    if (this.state.dictInterval) window.clearInterval(this.state.dictInterval);
    if (this.state.rendition) this.state.rendition.destroy();
    if (this.state.book) this.state.book.destroy();
    this.state = {
        book: null,
        rendition: null
    };
    this.qs(".bar .loc").innerHTML = "";
    this.qs(".search-results").innerHTML = "";
    this.qs(".search-box").value = "";
    this.qs(".toc-list").innerHTML = "";
    this.qs(".info .cover").src = "";
    this.qs(".info .title").innerHTML = "";
    this.qs(".info .author").innerHTML = "";
    this.qs(".book").innerHTML = '<div class="empty-wrapper"><div class="empty"><div class="app-name">ePubViewer</div><div class="message"><a href="javascript:ePubViewer.doOpenBook();" class="big-button">Open a Book</a></div></div></div>';
    this.qs(".bar button.prev").classList.add("hidden");
    this.qs(".bar button.next").classList.add("hidden");
    this.doDictionary(null);
};

App.prototype.qs = function (q) {
    return this.ael.querySelector(q);
};

App.prototype.qsa = function (q) {
    return Array.from(this.ael.querySelectorAll(q));
};

App.prototype.el = function (t, c) {
    let e = document.createElement(t);
    if (c) e.classList.add(c);
    return e;
};

App.prototype.onBookReady = function (event) {
    this.qs(".bar button.prev").classList.remove("hidden");
    this.qs(".bar button.next").classList.remove("hidden");

    console.log("bookKey", this.state.book.key());

    let chars = 1650;
    let key = `${this.state.book.key()}:locations-${chars}`;
    let stored = localStorage.getItem(key);
    console.log("storedLocations", typeof stored == "string" ? stored.substr(0, 40) + "..." : stored);

    if (stored) return this.state.book.locations.load(stored);
    console.log("generating locations");
    return this.state.book.locations.generate(chars).then(() => {
        localStorage.setItem(key, this.state.book.locations.save());
        console.log("locations generated", this.state.book.locations);
    }).catch(err => console.error("error generating locations", err));
};

App.prototype.userInitiated = false;

App.prototype.onTocItemClick = function (href, event) {
    console.log("tocClick", href);
    this.userInitiated = true;
    this.state.rendition.display(href).catch(err => console.warn("error displaying page", err));
    event.stopPropagation();
    event.preventDefault();
    this.qsa(".toc-list .item").forEach(el => el.classList.remove("active"));
    this.qs(`[href='${href}']`).classList.add('active');
};

App.prototype.getNavItem = function(loc, ignoreHash) {
    const tocItems = [].concat(...this.state.book.navigation.toc.map(item => [item, ...item.subitems]));
    return tocItems.find(item => {
        const itemHref = this.state.book.canonical(item.href);
        const locHref = this.state.book.canonical(loc.start.href);
        return ignoreHash ? itemHref.split("#")[0] === locHref.split("#")[0] : itemHref === locHref;
    }) || null;
};

App.prototype.onNavigationLoaded = function (nav) {
    console.log("navigation", nav);
    let toc = this.qs(".toc-list");
    toc.innerHTML = "";
    let handleItems = (items, indent) => {
        items.forEach(item => {
            let a = toc.appendChild(this.el("a", "item"));
            a.href = item.href;
            a.dataset.href = item.href;
            a.innerHTML = `${"&nbsp;".repeat(indent*4)}${item.label.trim()}`;
            a.addEventListener("click", this.onTocItemClick.bind(this, item.href));
            handleItems(item.subitems, indent + 1);
        });
    };
    handleItems(nav.toc, 0);
};

App.prototype.onRenditionRelocated = function (event) {
    this.loadBookmarks();

    console.log('firing!', event);
    if (this.userInitiated) {
        this.userInitiated = false;
    } else {
        try {this.doDictionary(null);} catch (err) {}
        try {
            let navItem = this.getNavItem(event, false) || this.getNavItem(event, true);
            this.qsa(".toc-list .item").forEach(el => el.classList[(navItem && el.dataset.href == navItem.href) ? "add" : "remove"]("active"));
        } catch (err) {
            this.fatal("error updating toc", err);
        }
    }
};

App.prototype.onBookMetadataLoaded = function (metadata) {
    console.log("metadata", metadata);
    this.qs(".info .title").innerText = metadata.title.trim();
    this.qs(".info .author").innerText = metadata.creator.trim();
};

App.prototype.onBookCoverLoaded = function (url) {
    if (!url)
        return;
    if (!this.state.book.archived) {
        this.qs(".cover").src = url;
        return;
    }
    this.state.book.archive.createUrl(url).then(url => {
        this.qs(".cover").src = url;
    }).catch(console.warn.bind(console));
};

App.prototype.onKeyUp = function (event) {
    event.preventDefault();
    if (this.state.enable_navigation === false) return;
    console.log('key up fired', this.state.enable_navigation);
    let kc = event.keyCode || event.which;
    let b = null;
    if (kc == 37) {
        this.state.rendition.prev();
        b = this.qs(".app .bar button.prev");
    } else if (kc == 39) {
        this.state.rendition.next();
        b = this.qs(".app .bar button.next");
    }
    if (b) {
        b.style.transform = "scale(1.15)";
        window.setTimeout(() => b.style.transform = "", 150);
    }
};

App.prototype.onRenditionDisplayedTouchSwipe = function (event) {
    let start = null;
    let end = null;
    const el = event.document.documentElement;

    el.addEventListener('touchstart', event => {
        start = event.changedTouches[0];
    });
    el.addEventListener('touchend', event => {
        end = event.changedTouches[0];

        let hr = (end.screenX - start.screenX) / el.getBoundingClientRect().width;
        let vr = (end.screenY - start.screenY) / el.getBoundingClientRect().height;

        if (!this.state.enable_navigation) return;

        if (hr > vr && hr > 0.25) return this.state.rendition.prev();
        if (hr < vr && hr < -0.25) return this.state.rendition.next();
        if (vr > hr && vr > 0.25) return;
        if (vr < hr && vr < -0.25) return;
    });
};

App.prototype.applyTheme = function () {
    let theme = {
        bg: this.getChipActive("theme").split(";")[0],
        fg: this.getChipActive("theme").split(";")[1],
        l: "#1e83d2",
        ff: this.getChipActive("font"),
        fs: this.getChipActive("font-size"),
        lh: this.getChipActive("line-spacing"),
        ta: "justify",
        m: this.getChipActive("margin")
    };

    let rules = {
        "body": {
            "background": theme.bg,
            "color": theme.fg,
            "font-family": theme.ff !== "" ? `${theme.ff} !important` : "!invalid-hack",
            "font-size": theme.fs !== "" ? `${theme.fs} !important` : "!invalid-hack",
            "line-height": `${theme.lh} !important`,
            "text-align": `${theme.ta} !important`,
            "padding-top": theme.m,
            "padding-bottom": theme.m
        },
        "p": {
            "font-family": theme.ff !== "" ? `${theme.ff} !important` : "!invalid-hack",
            "font-size": theme.fs !== "" ? `${theme.fs} !important` : "!invalid-hack",
        },
        "a": {
            "color": "inherit !important",
            "text-decoration": "none !important",
            "-webkit-text-fill-color": "inherit !important"
        },
        "a:link": {
            "color": `${theme.l} !important`,
            "text-decoration": "none !important",
            "-webkit-text-fill-color": `${theme.l} !important`
        },
        "a:link:hover": {
            "background": "rgba(0, 0, 0, 0.1) !important"
        },
        "img": {
            "max-width": "100% !important"
        },
    };

    try {
        this.ael.style.background = theme.bg;
        this.ael.style.fontFamily = theme.ff;
        this.ael.style.color = theme.fg;
        if (this.state.rendition) this.state.rendition.getContents().forEach(c => c.addStylesheetRules(rules));
    } catch (err) {
        console.error("error applying theme", err);
    }
};

App.prototype.loadFonts = function () {
    this.state.rendition.getContents().forEach(c => {
        [
            "https://fonts.googleapis.com/css?family=Arbutus+Slab",
            "https://fonts.googleapis.com/css?family=Lato:400,400i,700,700i"
        ].forEach(url => {
            let el = c.document.body.appendChild(c.document.createElement("link"));
            el.setAttribute("rel", "stylesheet");
            el.setAttribute("href", url);
        });
    });
};

App.prototype.onRenditionRelocatedUpdateIndicators = function (event) {
    try {
        if (this.getChipActive("progress") === "bar") {
            // TODO: don't recreate every time the location changes.
            this.qs(".bar .loc").innerHTML = "";
            
            let bar = this.qs(".bar .loc").appendChild(document.createElement("div"));
            bar.style.position = "relative";
            bar.style.width = "60vw";
            bar.style.cursor = "default";
            bar.addEventListener("click", ev => ev.stopImmediatePropagation(), false);

            let range = bar.appendChild(document.createElement("input"));
            range.type = "range";
            range.style.width = "100%";
            range.min = 0;
            range.max = this.state.book.locations.length();
            range.value = event.start.location;
            range.addEventListener("change", () => this.state.rendition.display(this.state.book.locations.cfiFromLocation(range.value)), false);

            let markers = bar.appendChild(document.createElement("div"));
            markers.style.position = "absolute";
            markers.style.width = "100%";
            markers.style.height = "50%";
            markers.style.bottom = "0";
            markers.style.left = "0";
            markers.style.right = "0";

            for (let i = 0, last = -1; i < this.state.book.locations.length(); i++) {
                try {
                    let parsed = new ePub.CFI().parse(this.state.book.locations.cfiFromLocation(i));
                    if (parsed.spinePos < 0 || parsed.spinePos === last) continue;
                    last = parsed.spinePos;

                    let marker = markers.appendChild(document.createElement("div"));
                    marker.style.position = "absolute";
                    marker.style.left = `${this.state.book.locations.percentageFromLocation(i) * 100}%`;
                    marker.style.width = "4px";
                    marker.style.height = "30%";
                    marker.style.cursor = "pointer";
                    marker.style.opacity = "0.5";
                    marker.addEventListener("click", this.onTocItemClick.bind(this, this.state.book.locations.cfiFromLocation(i)), false);

                    let tick = marker.appendChild(document.createElement("div"));
                    tick.style.width = "1px";
                    tick.style.height = "100%";
                    tick.style.backgroundColor = "currentColor";
                } catch (ex) {
                    console.warn("Error adding marker for location", i, ex);
                }
            }

            return;
        }

        let stxt = "Loading";
        if (this.getChipActive("progress") === "none") {
            console.log('its none')
            stxt = "";
        } else if (this.getChipActive("progress") === "location" && event.start.location > 0) {
            console.log('AHHA')
            stxt = `Loc ${event.start.location}/${this.state.book.locations.length()}`;
        } else if (this.getChipActive("progress") === "chapter") {
            let navItem = this.getNavItem(event, false) || this.getNavItem(event, true);
            stxt = navItem ? navItem.label.trim() : (event.start.percentage > 0 && event.start.percentage < 1) ? `${Math.round(event.start.percentage * 100)}%` : "";
        } else {
            stxt = (event.start.percentage > 0 && event.start.percentage < 1) ? `${Math.round(event.start.percentage * 1000) / 10}%` : "";
        }
        this.qs(".bar .loc").innerHTML = stxt;
    } catch (err) {
        console.error("error updating indicators", err);
    }
};

App.prototype.onRenditionRelocatedSavePos = function (event) {
    localStorage.setItem(`${this.state.book.key()}:pos`, event.start.cfi);
};

App.prototype.onRenditionStartedRestorePos = function (event) {
    try {
        let stored = localStorage.getItem(`${this.state.book.key()}:pos`);
        console.log("storedPos", stored);
        if (stored) this.state.rendition.display(stored);
    } catch (err) {
        this.fatal("error restoring position", err);
    }
};

App.prototype.checkDictionary = function () {
    try {
        let selection = (this.state.rendition.manager && this.state.rendition.manager.getContents().length > 0) ? this.state.rendition.manager.getContents()[0].window.getSelection().toString().trim() : "";
        if (selection.length < 2 || selection.indexOf(" ") > -1) {
            if (this.state.showDictTimeout) window.clearTimeout(this.state.showDictTimeout);
            this.doDictionary(null);
            return;
        }
        this.state.showDictTimeout = window.setTimeout(() => {
            try {
                let newSelection = this.state.rendition.manager.getContents()[0].window.getSelection().toString().trim();
                if (newSelection == selection) this.doDictionary(newSelection);
            } catch (err) {
                console.error(`showDictTimeout: ${err.toString()}`);
            }
        }, 300);
    } catch (err) {
        console.error(`checkDictionary: ${err.toString()}`);
    }
};

App.prototype.doDictionary = function (word) {
    if (this.state.lastWord && this.state.lastWord === word) return;
    this.state.lastWord = word;

    if (!this.qs(".dictionary-wrapper").classList.contains("hidden")) console.log("hide dictionary");
    this.qs(".dictionary-wrapper").classList.add("hidden");
    this.qs(".dictionary").innerHTML = "";
    if (!word) return;

    console.log(`define ${word}`);
    this.qs(".dictionary-wrapper").classList.remove("hidden");
    this.qs(".dictionary").innerHTML = "";

    let ldefinitionEl = this.qs(".dictionary").appendChild(document.createElement("div"));
    ldefinitionEl.classList.add("definition");

    let lwordEl = ldefinitionEl.appendChild(document.createElement("div"));
    lwordEl.classList.add("word");
    lwordEl.innerText = word;

    let lmeaningsEl = ldefinitionEl.appendChild(document.createElement("div"));
    lmeaningsEl.classList.add("meanings");
    lmeaningsEl.innerHTML = "Loading";

    fetch(`https://dict.api.pgaskin.net/word/${encodeURIComponent(word)}`).then(resp => {
        if (resp.status >= 500) throw new Error(`Dictionary not available`);
        if (resp.status === 404) throw new Error(`Word not found`);
        return resp.json();
    }).then(obj => {
        if (obj.status === "error") throw new Error(`ApiError: ${obj.result}`);
        return obj.result;
    }).then(obj => {
        console.log("dictLookup", obj);

        ldefinitionEl.parentElement.removeChild(ldefinitionEl);

        [obj].concat(obj.additional_words || []).concat(obj.referenced_words || []).map(word => {
            let definitionEl = this.qs(".dictionary").appendChild(document.createElement("div"));
            definitionEl.classList.add("definition");

            let wordEl = definitionEl.appendChild(document.createElement("div"));
            wordEl.classList.add("word");
            wordEl.innerText = [word.word].concat(word.alternates || []).join(", ").toLowerCase();

            let meaningsEl = definitionEl.appendChild(document.createElement("div"));
            meaningsEl.classList.add("meanings");

            if (word.info && word.info.trim() !== "") {
                let infoEl = meaningsEl.appendChild(document.createElement("div"));
                infoEl.classList.add("info");
                infoEl.innerText = word.info;
            }

            (word.meanings || []).map((meaning, i) => {
                let meaningEl = meaningsEl.appendChild(document.createElement("div"));
                meaningEl.classList.add("meaning");

                let meaningTextEl = meaningEl.appendChild(document.createElement("div"));
                meaningTextEl.classList.add("text");
                meaningTextEl.innerText = `${i + 1}. ${meaning.text}`;

                if (meaning.example && meaning.example.trim() !== "") {
                    let meaningExampleEl = meaningEl.appendChild(document.createElement("div"));
                    meaningExampleEl.classList.add("example");
                    meaningExampleEl.innerText = meaning.example;
                }
            });

            (word.notes || []).map(note => {
                let noteEl = meaningsEl.appendChild(document.createElement("div"));
                noteEl.classList.add("note");
                noteEl.innerText = note;
            });
        
            if (word.credit && word.credit.trim() !== "") {
                let creditEl = meaningsEl.appendChild(document.createElement("div"));
                creditEl.classList.add("credit");
                creditEl.innerText = word.credit;
            }
        });
    }).catch(err => {
        try {
            console.error("dictLookup", err);
            lmeaningsEl.innerText = err.toString();
        } catch (err) {}
    });
};

App.prototype.doFullscreen = () => {
    document.fullscreenEnabled = document.fullscreenEnabled || document.mozFullScreenEnabled || document.documentElement.webkitRequestFullScreen;

    let requestFullscreen = element => {
        if (element.requestFullscreen) {
            element.requestFullscreen();
        } else if (element.mozRequestFullScreen) {
            element.mozRequestFullScreen();
        } else if (element.webkitRequestFullScreen) {
            element.webkitRequestFullScreen(Element.ALLOW_KEYBOARD_INPUT);
        }
    };

    if (document.fullscreenEnabled) {
        requestFullscreen(document.documentElement);
    }
};

App.prototype.doSearch = function (q) {
    return Promise.all(this.state.book.spine.spineItems.map(item => {
        return item.load(this.state.book.load.bind(this.state.book)).then(doc => {
            let results = item.find(q);
            item.unload();
            return Promise.resolve(results);
        });
    })).then(results => Promise.resolve([].concat.apply([], results)));
};

App.prototype.onResultClick = function (href, event) {
    console.log("tocClick", href);
    this.state.rendition.display(href).then(() => {
        this.highlightTextInBook(this.qs(".sidebar .search-bar .search-box").value.trim());
    });
    event.stopPropagation();
    event.preventDefault();
};

App.prototype.highlightTextInBook = function (query) {
    const iframe = this.state.rendition.manager.getContents()[0].document;
    const regex = new RegExp(`(${query})`, 'gi');

    const highlightNode = (node) => {
        if (node.nodeType === 3) { // Text node
            const match = node.data.match(regex);
            if (match) {
                const span = document.createElement('span');
                span.className = 'highlight';
                const highlightedText = node.data.replace(regex, '<span class="highlight" style="background: yellow; font-weight: bold;">$1</span>');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = highlightedText;
                while (tempDiv.firstChild) {
                    span.appendChild(tempDiv.firstChild);
                }
                node.parentNode.replaceChild(span, node);
            }
        } else if (node.nodeType === 1 && node.childNodes && !/script|style/i.test(node.tagName)) {
            for (let i = 0; i < node.childNodes.length; i++) {
                highlightNode(node.childNodes[i]);
            }
        }
    };

    const body = iframe.body;
    highlightNode(body);
};

App.prototype.doTab = function (tab) {
    try {
        this.qsa(".tab-list .item").forEach(el => el.classList[(el.dataset.tab === tab) ? "add" : "remove"]("active"));
        this.qsa(".tab-container .tab").forEach(el => el.classList[(el.dataset.tab !== tab) ? "add" : "remove"]("hidden"));
        try {
            this.qs(".tab-container").scrollTop = 0;
        } catch (err) {}
    } catch (err) {
        this.fatal("error showing tab", err);
    }
};

App.prototype.onTabClick = function (tab, event) {
    console.log("tabClick", tab);
    this.doTab(tab);
    event.stopPropagation();
    event.preventDefault();
};

App.prototype.onSearchClick = function (event) {
    const query = this.qs(".sidebar .search-bar .search-box").value.trim();
    this.doSearch(query).then(results => {
        this.qs(".sidebar .search-results").innerHTML = "";
        let resultsEl = document.createDocumentFragment();
        results.slice(0, 200).forEach(result => {
            let resultEl = resultsEl.appendChild(this.el("a", "item"));
            resultEl.href = result.cfi;
            resultEl.addEventListener("click", this.onResultClick.bind(this, result.cfi));

            let textEl = resultEl.appendChild(this.el("div", "text"));
            textEl.innerHTML = this.highlightText(result.excerpt.trim(), query);

            resultEl.appendChild(this.el("div", "pbar")).appendChild(this.el("div", "pbar-inner")).style.width = (this.state.book.locations.percentageFromCfi(result.cfi) * 100).toFixed(3) + "%";
        });
        this.qs(".app .sidebar .search-results").appendChild(resultsEl);
    }).catch(err => this.fatal("error searching book", err));
};

App.prototype.highlightText = function (text, query) {
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<span class="highlight">$1</span>');
};

let ePubViewer = null;

try {
    ePubViewer = new App(document.querySelector(".app"));
    let ufn = location.search.replace("?", "") || location.hash.replace("#", "");
    if (ufn.startsWith("!")) {
        ufn = ufn.replace("!", "");
        document.querySelector(".app button.open").style = "display: none !important";
    }
    if (ufn) {
        fetch(ufn).then(resp => {
            if (resp.status !== 200) throw new Error("response status: " + resp.status.toString() + " " + resp.statusText);
            return resp.arrayBuffer();
        }).then(data => {
            ePubViewer.doBook(data, { encoding: "binary" });
        }).catch(err => {
            ePubViewer.fatal("error loading book", err, true);
        });
    }
} catch (err) {
    document.querySelector(".app .error").classList.remove("hidden");
    document.querySelector(".app .error .error-title").innerHTML = "Error";
    document.querySelector(".app .error .error-description").innerHTML = "Please try reloading the page or using a different browser (Chrome or Firefox), and if the error still persists, <a href=\"https://github.com/pgaskin/ePubViewer/issues\">report an issue</a>.";
    document.querySelector(".app .error .error-dump").innerHTML = JSON.stringify({
        error: err.toString(),
        stack: err.stack
    });
    try {
        if (!isRavenDisabled) Raven.captureException(err);
    } catch (err) {}
}

App.prototype.toggleBookmark = function () {
    const currentLocation = this.state.rendition.currentLocation();
    const bookmarkKey = `${this.state.book.key()}:bookmarks`;
    let bookmarks = JSON.parse(localStorage.getItem(bookmarkKey)) || [];

    // Retrieve the chapter title using the `getNavItem` method
    const navItem = this.getNavItem(currentLocation, true);
    const chapter = navItem ? navItem.label : 'Unknown Chapter';
    const page = currentLocation.start.location; // Assuming page number from location
    const percentage = (currentLocation.start.percentage * 100).toFixed(2);

    const existingBookmarkIndex = bookmarks.findIndex(b => b.cfi === currentLocation.start.cfi);

    if (existingBookmarkIndex !== -1) {
        bookmarks.splice(existingBookmarkIndex, 1); // Remove bookmark
        this.qs(".bookmark i").textContent = "bookmark_border";
    } else {
        bookmarks.push({
            cfi: currentLocation.start.cfi,
            chapter: chapter,
            page: page,
            percentage: percentage
        });
        this.qs(".bookmark i").textContent = "bookmark";
    }

    localStorage.setItem(bookmarkKey, JSON.stringify(bookmarks));
};

App.prototype.loadBookmarks = function () {
    const bookmarkKey = `${this.state.book.key()}:bookmarks`;
    const bookmarks = JSON.parse(localStorage.getItem(bookmarkKey)) || [];

    const bookmarksContainer = document.querySelector('[data-tab="bookmarks"] .bookmarks');
    bookmarksContainer.innerHTML = ''; // Clear any existing bookmarks

    bookmarks.forEach(bookmark => {
        const bookmarkEl = document.createElement('div');
        bookmarkEl.classList.add('bookmark-link');

        bookmarkEl.innerHTML = `
            <a href="#" data-cfi="${bookmark.cfi}">
                ${bookmark.chapter} - Page ${bookmark.page} (${bookmark.percentage}%)
            </a>
        `;
        bookmarksContainer.appendChild(bookmarkEl);
    });

    // Ensure that the rendition and manager are ready and currentLocation has a valid start
    if (this.state.rendition && this.state.rendition.manager) {
        const currentLocation = this.state.rendition.currentLocation();
        if (currentLocation && currentLocation.start && bookmarks.some(b => b.cfi === currentLocation.start.cfi)) {
            this.qs(".bookmark i").textContent = "bookmark";
        } else {
            this.qs(".bookmark i").textContent = "bookmark_border";
        }
    } else {
        console.warn('Rendition or manager is not ready, skipping bookmark state update');
    }

    // Add event listener to handle bookmark clicks
    bookmarksContainer.querySelectorAll('a[data-cfi]').forEach(link => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            const cfi = event.target.getAttribute('data-cfi');
            this.state.rendition.display(cfi);
        });
    });
};

document.addEventListener("DOMContentLoaded", function() {
    const toggleButtons = document.querySelectorAll(".toggle-sidebar");
    const sidebar = document.querySelector(".sidebar");
    const main = document.querySelector(".main");

    toggleButtons.forEach(toggleButton => {
        toggleButton.addEventListener("click", function() {
            sidebar.classList.toggle("hidden");
            main.classList.toggle("sidebar-hidden");
            if (sidebar.classList.contains("hidden")) {
                toggleButton.innerHTML = '<i class="icon material-icons-outlined">menu</i>';
            } else {
                toggleButton.innerHTML = '<i class="icon material-icons-outlined">menu</i>';
            }

            const resizeEvent = new Event('resize');
            window.dispatchEvent(resizeEvent);
        });
    })

    const bookmarkButton = document.querySelector(".bookmark");
    bookmarkButton.addEventListener("click", function() {
        ePubViewer.toggleBookmark();
    });
});

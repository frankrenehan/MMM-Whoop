/* MMM-Whoop
 * MagicMirror² module for displaying WHOOP health data
 * https://github.com/frankrenehan/MMM-Whoop
 *
 * Multi-user: each module instance sets a userId. The node_helper
 * tags all notifications with userId so each frontend instance
 * only processes its own data.
 *
 * MIT Licensed
 */

Module.register("MMM-Whoop", {
  defaults: {
    userId: "default",
    displayName: "",
    updateInterval: 15 * 60 * 1000, // 15 minutes
    animationSpeed: 1000,
    showActivities: true,
    maxActivities: 3,
    useEmoji: false,
    retryDelay: 30 * 1000,
    // OAuth credentials – populated from config.js
    clientId: "",
    clientSecret: "",
  },

  getStyles: function () {
    return ["MMM-Whoop.css"];
  },

  start: function () {
    Log.info("Starting module: " + this.name + " [" + this.config.userId + "]");
    this.recoveryData = null;
    this.sleepData = null;
    this.cycleData = null;
    this.workoutData = null;
    this.prevRecovery = null;
    this.prevSleep = null;
    this.prevCycle = null;
    this.fetchedAt = null;
    this.loaded = false;
    this.error = null;
    this.stale = false;

    this.sendSocketNotification("WHOOP_INIT", this.config);
  },

  socketNotificationReceived: function (notification, payload) {
    // Filter: only process notifications for this instance's user
    if (payload.userId !== this.config.userId) return;

    switch (notification) {
      case "WHOOP_DATA":
        this.processData(payload);
        this.loaded = true;
        this.error = null;
        this.stale = false;
        this.updateDom(this.config.animationSpeed);
        break;
      case "WHOOP_ERROR":
        if (this.loaded) {
          this.stale = true;
          this.error = null;
        } else {
          this.error = payload.message;
        }
        this.updateDom(this.config.animationSpeed);
        break;
    }
  },

  processData: function (data) {
    this.recoveryData = data.recovery;
    this.sleepData = data.sleep;
    this.cycleData = data.cycle;
    this.workoutData = data.workouts;
    this.prevRecovery = data.prevRecovery || null;
    this.prevSleep = data.prevSleep || null;
    this.prevCycle = data.prevCycle || null;
    this.fetchedAt = data.fetchedAt || null;
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-whoop";

    if (this.error) {
      var errorDiv = document.createElement("div");
      errorDiv.className = "whoop-error dimmed small";
      errorDiv.textContent = this.error;
      wrapper.appendChild(errorDiv);
      return wrapper;
    }

    if (!this.loaded) {
      var loadingDiv = document.createElement("div");
      loadingDiv.className = "whoop-loading dimmed small";
      loadingDiv.textContent = "Loading WHOOP data\u2026";
      wrapper.appendChild(loadingDiv);
      return wrapper;
    }

    // Display name (for multi-user)
    if (this.config.displayName) {
      var nameEl = document.createElement("div");
      nameEl.className = "whoop-display-name";
      nameEl.textContent = this.config.displayName;
      wrapper.appendChild(nameEl);
    }

    // Main scores row
    var scoresRow = document.createElement("div");
    scoresRow.className = "whoop-scores";

    scoresRow.appendChild(
      this.buildScoreCard(
        "RECOVERY",
        this.getRecoveryScore(),
        "%",
        this.getRecoveryDelta(),
        this.getRecoveryZone(),
        false
      )
    );

    scoresRow.appendChild(
      this.buildScoreCard(
        "SLEEP",
        this.getSleepScore(),
        "%",
        this.getSleepDelta(),
        this.getSleepZone(),
        false
      )
    );

    scoresRow.appendChild(
      this.buildScoreCard(
        "STRAIN",
        this.getStrainScore(),
        "",
        this.getStrainDelta(),
        this.getStrainZone(),
        true
      )
    );

    wrapper.appendChild(scoresRow);

    // Activities
    if (
      this.config.showActivities &&
      this.workoutData &&
      this.workoutData.length > 0
    ) {
      var activitiesSection = document.createElement("div");
      activitiesSection.className = "whoop-activities";

      var workouts = this.workoutData.slice(0, this.config.maxActivities);
      workouts.forEach(
        function (workout) {
          activitiesSection.appendChild(this.buildActivityRow(workout));
        }.bind(this)
      );

      wrapper.appendChild(activitiesSection);
    }

    // Stale indicator
    if (this.stale) {
      var staleDiv = document.createElement("div");
      staleDiv.className = "whoop-stale dimmed";
      staleDiv.textContent = "Update pending\u2026";
      if (this.fetchedAt) {
        var ago = this.formatAgo(this.fetchedAt);
        if (ago) staleDiv.textContent = "Updated " + ago + " ago";
      }
      wrapper.appendChild(staleDiv);
    }

    return wrapper;
  },

  buildScoreCard: function (label, value, unit, delta, zone, neutralDelta) {
    var card = document.createElement("div");
    card.className = "whoop-card";

    var labelEl = document.createElement("div");
    labelEl.className = "whoop-label dimmed";
    labelEl.textContent = label;
    card.appendChild(labelEl);

    var valueRow = document.createElement("div");
    valueRow.className = "whoop-value-row";

    var valueEl = document.createElement("span");
    valueEl.className = "whoop-value whoop-zone-" + zone;
    if (value != null) {
      valueEl.textContent =
        value === Math.floor(value) ? value : value.toFixed(1);
    } else {
      valueEl.textContent = "--";
    }
    valueRow.appendChild(valueEl);

    if (unit && value != null) {
      var unitEl = document.createElement("span");
      unitEl.className = "whoop-unit whoop-zone-" + zone;
      unitEl.textContent = unit;
      valueRow.appendChild(unitEl);
    }

    card.appendChild(valueRow);

    // Delta
    var deltaEl = document.createElement("div");
    if (delta != null) {
      var arrow = delta > 0 ? "\u25B2" : delta < 0 ? "\u25BC" : "\u25B8";
      var deltaClass = neutralDelta
        ? "whoop-delta-neutral"
        : delta > 0
          ? "whoop-delta-up"
          : delta < 0
            ? "whoop-delta-down"
            : "whoop-delta-flat";
      deltaEl.className = "whoop-delta " + deltaClass;
      var absDelta = Math.abs(delta);
      var formatted = absDelta === Math.floor(absDelta)
        ? absDelta.toString()
        : absDelta.toFixed(1);
      deltaEl.textContent = arrow + " " + formatted;
    } else {
      deltaEl.className = "whoop-delta dimmed";
      deltaEl.textContent = "\u00A0";
    }
    card.appendChild(deltaEl);

    return card;
  },

  buildActivityRow: function (workout) {
    var wrapper = document.createElement("div");
    wrapper.className = "whoop-activity";

    // Primary line – icon, name, strain, distance
    var row = document.createElement("div");
    row.className = "whoop-activity-row";

    var icon = document.createElement("span");
    icon.className = "whoop-activity-icon";
    icon.textContent = this.getSportIcon(workout.sport_name);
    row.appendChild(icon);

    var name = document.createElement("span");
    name.className = "whoop-activity-name";
    name.textContent = this.formatSportName(workout.sport_name);
    row.appendChild(name);

    if (workout.score) {
      var strain = document.createElement("span");
      strain.className = "whoop-activity-strain";
      strain.textContent =
        workout.score.strain != null
          ? workout.score.strain.toFixed(1)
          : "--";
      row.appendChild(strain);

      if (workout.score.distance_meter != null && workout.score.distance_meter > 0) {
        var distance = document.createElement("span");
        distance.className = "whoop-activity-distance";
        var km = (workout.score.distance_meter / 1000).toFixed(1);
        distance.textContent = km + "km";
        row.appendChild(distance);
      }
    }

    wrapper.appendChild(row);

    // Secondary line – duration, calories
    var details = [];
    if (workout.start && workout.end) {
      var ms = new Date(workout.end) - new Date(workout.start);
      var mins = Math.round(ms / 60000);
      if (mins >= 60) {
        details.push(Math.floor(mins / 60) + "h " + (mins % 60) + "m");
      } else {
        details.push(mins + "m");
      }
    }
    if (workout.score && workout.score.kilojoule != null) {
      details.push(Math.round(workout.score.kilojoule / 4.184) + " cal");
    }
    if (details.length > 0) {
      var detail = document.createElement("div");
      detail.className = "whoop-activity-detail";
      detail.textContent = details.join("  ·  ");
      wrapper.appendChild(detail);
    }

    return wrapper;
  },

  // --- Data extraction helpers (always return numbers) ---

  getRecoveryScore: function () {
    if (!this.recoveryData || !this.recoveryData.score) return null;
    return Math.round(this.recoveryData.score.recovery_score);
  },

  getSleepScore: function () {
    if (!this.sleepData || !this.sleepData.score) return null;
    return Math.round(this.sleepData.score.sleep_performance_percentage);
  },

  getStrainScore: function () {
    if (!this.cycleData || !this.cycleData.score) return null;
    if (this.cycleData.score.strain == null) return null;
    return this.cycleData.score.strain;
  },

  getRecoveryDelta: function () {
    var curr = this.getRecoveryScore();
    if (curr == null || !this.prevRecovery || !this.prevRecovery.score)
      return null;
    return curr - Math.round(this.prevRecovery.score.recovery_score);
  },

  getSleepDelta: function () {
    var curr = this.getSleepScore();
    if (curr == null || !this.prevSleep || !this.prevSleep.score) return null;
    return curr - Math.round(this.prevSleep.score.sleep_performance_percentage);
  },

  getStrainDelta: function () {
    if (!this.cycleData || !this.cycleData.score) return null;
    if (this.cycleData.score.strain == null) return null;
    if (!this.prevCycle || !this.prevCycle.score) return null;
    if (this.prevCycle.score.strain == null) return null;
    return this.cycleData.score.strain - this.prevCycle.score.strain;
  },

  // Zone classification
  getRecoveryZone: function () {
    var score = this.getRecoveryScore();
    if (score == null) return "none";
    if (score >= 67) return "green";
    if (score >= 34) return "yellow";
    return "red";
  },

  getSleepZone: function () {
    var score = this.getSleepScore();
    if (score == null) return "none";
    if (score >= 90) return "green";
    if (score >= 75) return "yellow";
    return "red";
  },

  getStrainZone: function () {
    // Strain is informational – not directionally good or bad
    return "none";
  },

  getSportIcon: function (sport) {
    if (!this.config.useEmoji) return "\u2022"; // bullet dot

    // Color emoji – requires fonts-noto-color-emoji on the Pi
    var icons = {
      running: "\uD83C\uDFC3",
      cycling: "\uD83D\uDEB4",
      swimming: "\uD83C\uDFCA",
      weightlifting: "\uD83C\uDFCB\uFE0F",
      crossfit: "\uD83C\uDFCB\uFE0F",
      yoga: "\uD83E\uDDD8",
      hiking: "\uD83E\uDD7E",
      walking: "\uD83D\uDEB6",
      rowing: "\uD83D\uDEA3",
      tennis: "\uD83C\uDFBE",
      basketball: "\uD83C\uDFC0",
      soccer: "\u26BD",
      golf: "\u26F3",
      functional_fitness: "\uD83D\uDCAA",
    };
    return icons[sport] || "\uD83C\uDFC3";
  },

  formatSportName: function (sport) {
    if (!sport) return "Activity";
    return sport.replace(/_/g, " ").replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  },

  formatAgo: function (isoString) {
    try {
      var diff = Date.now() - new Date(isoString).getTime();
      var mins = Math.round(diff / 60000);
      if (mins < 1) return null;
      if (mins < 60) return mins + "m";
      var hrs = Math.round(mins / 60);
      return hrs + "h";
    } catch (e) {
      return null;
    }
  },
});

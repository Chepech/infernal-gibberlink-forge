"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  encodeTextToGibberlink,
  frequencyForSymbol,
  GIBBERLINK_PROTOCOL,
  type GibberlinkPacket,
} from "@/lib/gibberlink/codec";
import {
  isLocale,
  localeLabels,
  locales,
  messages,
  type Locale,
  type MessageKey,
} from "@/i18n/messages";

type RuntimeConfig = {
  defaultFolder: string;
  allowedRoots: string[];
  maxFileBytes: number;
  maxFiles: number;
  maxDepth: number;
};

type LocalTextFile = {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
};

type TextDocument = LocalTextFile & {
  content: string;
  lineCount: number;
};

type ScanResponse = {
  folder: string;
  files: LocalTextFile[];
  skipped: { path: string; reason: string }[];
  limits: {
    maxFileBytes: number;
    maxFiles: number;
    maxDepth: number;
  };
};

type ReadResponse = {
  documents: TextDocument[];
  skipped: { path: string; reason: string }[];
  totalBytes: number;
};

type Translation = {
  text: string;
  documents: TextDocument[];
  packet: GibberlinkPacket;
};

type StatusEvent = {
  key: MessageKey;
  detail?: string;
};

export function InfernalTranslator() {
  const [locale, setLocale] = useState<Locale>("en");
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [folder, setFolder] = useState("");
  const [files, setFiles] = useState<LocalTextFile[]>([]);
  const [skipped, setSkipped] = useState<ScanResponse["skipped"]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [busy, setBusy] = useState<"scan" | "translate" | "audio" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<StatusEvent[]>([{ key: "ready" }]);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadExpiry, setUploadExpiry] = useState<string | null>(null);
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const uploadIdRef = useRef<string | null>(null);

  const t = messages[locale];
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedSet.has(file.path)),
    [files, selectedSet],
  );

  useEffect(() => {
    const savedLocale = window.localStorage.getItem("infernal-gibberlink-locale");
    const browserLocale = window.navigator.language.split("-")[0];
    const nextLocale = isLocale(savedLocale)
      ? savedLocale
      : isLocale(browserLocale)
        ? browserLocale
        : "en";
    setLocale(nextLocale);
  }, []);

  useEffect(() => {
    async function loadRuntime() {
      try {
        const config = await requestJson<RuntimeConfig>("/api/runtime");
        setRuntime(config);
        setFolder(config.defaultFolder);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load runtime config.");
      }
    }

    void loadRuntime();
  }, []);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      const id = uploadIdRef.current;
      if (id) {
        void fetch(`/api/uploads/${id}`, { method: "DELETE" });
      }
    };
  }, []);

  function pushEvent(key: MessageKey, detail?: string) {
    setEvents((current) => [{ key, detail }, ...current].slice(0, 8));
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem("infernal-gibberlink-locale", nextLocale);
  }

  function toggleSelection(path: string) {
    setSelectedPaths((current) =>
      current.includes(path)
        ? current.filter((selectedPath) => selectedPath !== path)
        : [...current, path],
    );
  }

  function selectAll() {
    setSelectedPaths(files.map((file) => file.path));
  }

  function clearSelection() {
    setSelectedPaths([]);
  }

  async function handleUploadFiles(selectedFiles: FileList | File[]) {
    const fileArray = Array.from(selectedFiles);
    if (fileArray.length === 0) return;

    setUploadBusy(true);
    setUploadError(null);
    setUploadSummary(null);
    setUploadProgress(null);

    try {
      // Step 1: Create upload session
      const createRes = await fetch("/api/uploads/create", { method: "POST" });
      if (!createRes.ok) {
        const payload = await safeJson<{ error?: { message?: string } }>(createRes);
        throw new Error(payload?.error?.message ?? t.uploadError);
      }
      const createData = (await createRes.json()) as { uploadId: string; expiresAt: string };
      const newUploadId = createData.uploadId;
      setUploadId(newUploadId);
      uploadIdRef.current = newUploadId;
      setUploadExpiry(createData.expiresAt);

      // Step 2: Upload files as multipart/form-data
      setUploadProgress({ done: 0, total: fileArray.length });
      const formData = new FormData();
      for (const file of fileArray) {
        formData.append("file", file, file.name);
      }
      const uploadRes = await fetch(`/api/uploads/${newUploadId}/files`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) {
        const payload = await safeJson<{ error?: { message?: string } }>(uploadRes);
        throw new Error(payload?.error?.message ?? t.uploadError);
      }
      setUploadProgress({ done: fileArray.length, total: fileArray.length });

      // Step 3: Get file list from the upload session
      const sessionRes = await fetch(`/api/uploads/${newUploadId}`);
      if (!sessionRes.ok) {
        const payload = await safeJson<{ error?: { message?: string } }>(sessionRes);
        throw new Error(payload?.error?.message ?? t.uploadError);
      }
      const sessionData = (await sessionRes.json()) as { folder: string; files: LocalTextFile[] };

      // Step 4: Hand off to the existing forge flow
      setFolder(sessionData.folder);
      setFiles(sessionData.files);
      setSelectedPaths(sessionData.files.map((f) => f.path));
      setSkipped([]);
      setTranslation(null);
      stopAudio();
      revokeAudioUrl();

      const summary = t.uploadFilesReady.replace("{count}", String(sessionData.files.length));
      setUploadSummary(summary);
      pushEvent("scanDone", `${sessionData.files.length} ${t.files.toLowerCase()}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t.uploadError);
    } finally {
      setUploadBusy(false);
    }
  }

  function clearUpload() {
    const id = uploadIdRef.current;
    if (id) {
      void fetch(`/api/uploads/${id}`, { method: "DELETE" });
      uploadIdRef.current = null;
    }
    setUploadId(null);
    setUploadExpiry(null);
    setUploadProgress(null);
    setUploadSummary(null);
    setUploadError(null);
  }

  async function scanFolder() {
    setBusy("scan");
    setError(null);
    setTranslation(null);
    stopAudio();
    revokeAudioUrl();

    try {
      const result = await requestJson<ScanResponse>(
        `/api/folders/scan?folder=${encodeURIComponent(folder)}`,
      );
      setFolder(result.folder);
      setFiles(result.files);
      setSkipped(result.skipped);
      setSelectedPaths(result.files.map((file) => file.path));
      pushEvent("scanDone", `${result.files.length} ${t.files.toLowerCase()}`);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Folder scan failed.");
    } finally {
      setBusy(null);
    }
  }

  async function forgeGibberlink() {
    if (selectedPaths.length === 0) {
      setError(t.noFiles);
      return;
    }

    setBusy("translate");
    setError(null);
    stopAudio();
    revokeAudioUrl();

    try {
      const readResult = await requestJson<ReadResponse>("/api/files/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: selectedPaths }),
      });

      if (readResult.documents.length === 0) {
        setError(t.noFiles);
        return;
      }

      const corpus = buildCorpus(readResult.documents);
      const packet = encodeTextToGibberlink(corpus);
      setTranslation({ text: corpus, documents: readResult.documents, packet });
      setSkipped((current) => [...current, ...readResult.skipped]);
      pushEvent(
        "forgeDone",
        `${readResult.documents.length} ${t.filesLoaded} · ${formatDuration(packet.durationSeconds)}`,
      );
    } catch (translateError) {
      setError(translateError instanceof Error ? translateError.message : "Gibberlink forge failed.");
    } finally {
      setBusy(null);
    }
  }

  async function playOrStop() {
    if (!translation) {
      return;
    }

    if (isPlaying) {
      stopAudio();
      return;
    }

    setBusy("audio");
    setError(null);

    try {
      const audioUrl = await ensureAudioUrl(translation.text);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audio.onended = () => setIsPlaying(false);
      audio.onerror = () => {
        setIsPlaying(false);
        setError(t.audioError);
      };
      await audio.play();
      setIsPlaying(true);
      pushEvent("audioReady", formatDuration(translation.packet.durationSeconds));
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : t.audioError);
    } finally {
      setBusy(null);
    }
  }

  async function downloadWav() {
    if (!translation) {
      return;
    }

    setBusy("audio");
    setError(null);

    try {
      const audioUrl = await ensureAudioUrl(translation.text);
      const anchor = document.createElement("a");
      anchor.href = audioUrl;
      anchor.download = `gibberlink-${translation.packet.checksum}.wav`;
      anchor.click();
      pushEvent("audioReady", `gibberlink-${translation.packet.checksum}.wav`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : t.audioError);
    } finally {
      setBusy(null);
    }
  }

  async function ensureAudioUrl(text: string) {
    if (audioUrlRef.current) {
      return audioUrlRef.current;
    }

    const response = await fetch("/api/gibberlink/wav", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const payload = await safeJson<{ error?: { message?: string } }>(response);
      throw new Error(payload?.error?.message ?? t.audioError);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    return url;
  }

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setIsPlaying(false);
  }

  function revokeAudioUrl() {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  const totalSelectedBytes = selectedFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const totalLines = translation?.documents.reduce((total, document) => total + document.lineCount, 0) ?? 0;

  return (
    <main className="hellscape min-h-screen overflow-hidden px-4 py-6 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr] lg:items-stretch">
          <section className="brutal-panel relative overflow-hidden p-6 sm:p-8 lg:p-10">
            <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-red-500 to-transparent" />
            <p className="text-xs font-black uppercase tracking-[0.55em] text-red-400">{t.eyebrow}</p>
            <h1 className="mt-4 max-w-5xl text-balance text-4xl font-black uppercase leading-[0.9] tracking-[-0.06em] text-zinc-50 sm:text-6xl lg:text-7xl">
              {t.heroTitle}
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-zinc-300 sm:text-lg">{t.heroBody}</p>
            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              <Metric label={t.protocol} value="GLNK v1" />
              <Metric label={t.symbols} value={`${GIBBERLINK_PROTOCOL.symbolCount} FSK`} />
              <Metric label={t.duration} value="44.1 kHz" />
            </div>
          </section>

          <aside className="brutal-panel p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.language}</p>
                <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.04em]">{t.appName}</h2>
              </div>
              <select
                className="h-11 rounded-none border border-red-900/70 bg-black px-3 text-sm font-bold text-zinc-100 outline-none ring-red-500/30 focus:ring-4"
                value={locale}
                onChange={(event) => changeLocale(event.target.value as Locale)}
                aria-label={t.language}
              >
                {locales.map((availableLocale) => (
                  <option key={availableLocale} value={availableLocale}>
                    {localeLabels[availableLocale]}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-6 space-y-4 text-sm text-zinc-300">
              <InfoBlock title={t.protocol} body={t.protocolBody} />
              <InfoBlock title={t.dockerHint} body={t.dockerHintBody} />
            </div>
          </aside>
        </header>

        <section className="grid gap-6 xl:grid-cols-[0.82fr_1.18fr]">
          <div className="space-y-6">
            {/* Upload Files panel */}
            <section className="brutal-panel p-5 sm:p-6">
              <button
                className="flex w-full items-center justify-between gap-3"
                onClick={() => setUploadPanelOpen((prev) => !prev)}
                aria-expanded={uploadPanelOpen}
              >
                <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.uploadSectionTitle}</p>
                <span className="text-xs font-black uppercase tracking-widest text-zinc-500">
                  {uploadPanelOpen ? "▲" : "▼"}
                </span>
              </button>

              {uploadPanelOpen ? (
                <div className="mt-4 space-y-4">
                  {/* Hidden file inputs */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.csv"
                    className="hidden"
                    onChange={(e) => { if (e.target.files) void handleUploadFiles(e.target.files); e.target.value = ""; }}
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    // @ts-expect-error — webkitdirectory is non-standard but widely supported
                    webkitdirectory=""
                    className="hidden"
                    onChange={(e) => { if (e.target.files) void handleUploadFiles(e.target.files); e.target.value = ""; }}
                  />

                  {/* Drop zone */}
                  <div
                    className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-red-900/50 bg-black/40 p-6 text-center transition hover:border-red-700"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer.files.length > 0) void handleUploadFiles(e.dataTransfer.files);
                    }}
                  >
                    <p className="text-sm text-zinc-500">{t.uploadDropHere}</p>
                    <p className="text-xs text-zinc-600">.txt · .md · .json · .csv</p>
                  </div>

                  {/* Browse buttons */}
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="hell-button min-h-10 px-4 text-sm"
                      disabled={uploadBusy}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {t.uploadBrowse}
                    </button>
                    <button
                      className="micro-button"
                      disabled={uploadBusy}
                      onClick={() => folderInputRef.current?.click()}
                    >
                      {t.uploadBrowseFolder}
                    </button>
                    {uploadId ? (
                      <button
                        className="micro-button"
                        disabled={uploadBusy}
                        onClick={clearUpload}
                      >
                        {t.uploadClear}
                      </button>
                    ) : null}
                  </div>

                  {/* Progress */}
                  {uploadBusy && uploadProgress ? (
                    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      {t.uploading} {uploadProgress.done} / {uploadProgress.total} {t.files.toLowerCase()}
                    </p>
                  ) : null}

                  {/* Success summary */}
                  {!uploadBusy && uploadSummary ? (
                    <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                      {t.uploadDone} — {uploadSummary}
                    </p>
                  ) : null}

                  {/* Expiry */}
                  {!uploadBusy && uploadExpiry ? (
                    <p className="text-xs tracking-widest text-zinc-400">
                      {t.uploadExpiresAt} {new Date(uploadExpiry).toLocaleTimeString()}
                    </p>
                  ) : null}

                  {/* Error */}
                  {uploadError ? (
                    <p className="text-xs font-bold text-red-400">{uploadError}</p>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="brutal-panel p-5 sm:p-6">
              <label className="text-xs font-black uppercase tracking-[0.35em] text-red-400" htmlFor="folder">
                {t.folderLabel}
              </label>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <input
                  id="folder"
                  className="min-h-12 flex-1 border border-red-950/80 bg-black/80 px-4 font-mono text-sm text-zinc-100 outline-none ring-red-600/20 placeholder:text-zinc-600 focus:ring-4"
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder="/data/input"
                />
                <button className="hell-button min-h-12 px-5" disabled={busy === "scan"} onClick={scanFolder}>
                  {busy === "scan" ? t.scanning : t.scan}
                </button>
              </div>
              <p className="mt-3 text-sm text-zinc-400">{t.folderHelp}</p>
              {runtime ? (
                <div className="mt-4 grid gap-3 text-xs text-zinc-400 sm:grid-cols-2">
                  <div className="border border-zinc-800 bg-black/40 p-3">
                    <span className="block font-black uppercase text-zinc-200">{t.allowedRoots}</span>
                    <span className="mt-1 block break-all font-mono">{runtime.allowedRoots.join(", ")}</span>
                  </div>
                  <div className="border border-zinc-800 bg-black/40 p-3">
                    <span className="block font-black uppercase text-zinc-200">{t.maxFileBytes}</span>
                    <span className="mt-1 block font-mono">{formatBytes(runtime.maxFileBytes)}</span>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="brutal-panel p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.files}</p>
                  <h2 className="mt-1 text-2xl font-black uppercase tracking-[-0.04em]">
                    {selectedPaths.length}/{files.length} {t.selected}
                  </h2>
                </div>
                <div className="flex gap-2">
                  <button className="micro-button" onClick={selectAll} disabled={files.length === 0}>
                    {t.selectAll}
                  </button>
                  <button className="micro-button" onClick={clearSelection} disabled={selectedPaths.length === 0}>
                    {t.clear}
                  </button>
                </div>
              </div>

              <div className="mt-5 max-h-[430px] space-y-2 overflow-auto pr-1">
                {files.length === 0 ? (
                  <p className="border border-dashed border-zinc-800 bg-black/40 p-5 text-sm text-zinc-400">{t.noFiles}</p>
                ) : (
                  files.map((file) => (
                    <label
                      key={file.path}
                      className="group flex cursor-pointer gap-3 border border-zinc-800 bg-black/55 p-3 transition hover:border-red-800/80 hover:bg-red-950/20"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-red-600"
                        checked={selectedSet.has(file.path)}
                        onChange={() => toggleSelection(file.path)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm font-bold text-zinc-100">{file.relativePath}</span>
                        <span className="mt-1 block text-xs uppercase tracking-[0.18em] text-zinc-500">
                          {formatBytes(file.sizeBytes)} · {t.modified} {new Date(file.modifiedAt).toLocaleString(locale)}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </div>

              <button
                className="hell-button mt-5 min-h-12 w-full px-5"
                disabled={busy === "translate" || selectedPaths.length === 0}
                onClick={forgeGibberlink}
              >
                {busy === "translate" ? t.translating : t.translate}
              </button>
            </section>

            <section className="brutal-panel p-5 sm:p-6">
              <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.brutalStatus}</p>
              <div className="mt-4 space-y-2">
                {error ? (
                  <p className="border border-red-800 bg-red-950/50 p-3 text-sm font-bold text-red-100">
                    {t.error}: {error}
                  </p>
                ) : null}
                {events.map((event, index) => (
                  <p key={`${event.key}-${index}`} className="border border-zinc-800 bg-black/50 p-3 text-sm text-zinc-300">
                    <span className="font-black uppercase text-zinc-50">{t[event.key]}</span>
                    {event.detail ? <span className="text-zinc-500"> · {event.detail}</span> : null}
                  </p>
                ))}
                {skipped.length > 0 ? (
                  <details className="border border-zinc-800 bg-black/50 p-3 text-sm text-zinc-400">
                    <summary className="cursor-pointer font-black uppercase text-zinc-100">
                      {t.skipped}: {skipped.length}
                    </summary>
                    <ul className="mt-3 space-y-1 font-mono text-xs">
                      {skipped.slice(0, 24).map((item, index) => (
                        <li key={`${item.path}-${index}`} className="break-all">
                          {item.reason}: {item.path}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="brutal-panel p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.payload}</p>
                  <h2 className="mt-1 text-2xl font-black uppercase tracking-[-0.04em]">{t.waveform}</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="micro-button" disabled={!translation || busy === "audio"} onClick={playOrStop}>
                    {isPlaying ? t.stop : t.play}
                  </button>
                  <button className="micro-button" disabled={!translation || busy === "audio"} onClick={downloadWav}>
                    {t.download}
                  </button>
                </div>
              </div>

              <div className="mt-5">
                {translation ? (
                  <WaveformCanvas
                    symbols={translation.packet.symbols}
                    durationSeconds={translation.packet.durationSeconds}
                  />
                ) : (
                  <div className="grid min-h-[260px] place-items-center border border-dashed border-zinc-800 bg-black/50 p-8 text-center text-sm uppercase tracking-[0.3em] text-zinc-500">
                    {t.noWaveform}
                  </div>
                )}
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label={t.bytes} value={formatBytes(totalSelectedBytes)} />
                <Metric label={t.lines} value={String(totalLines)} />
                <Metric label={t.symbols} value={translation ? String(translation.packet.symbols.length) : "0"} />
                <Metric label={t.duration} value={translation ? formatDuration(translation.packet.durationSeconds) : "0s"} />
              </div>
              {translation ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Metric label={t.checksum} value={translation.packet.checksum} monospace />
                  <Metric label={t.protocol} value={`GLNK v${translation.packet.protocol.version}`} monospace />
                </div>
              ) : null}
            </section>

            <section className="brutal-panel p-5 sm:p-6">
              <p className="text-xs font-black uppercase tracking-[0.35em] text-red-400">{t.translatedText}</p>
              <pre className="mt-4 max-h-[560px] overflow-auto border border-zinc-800 bg-black/80 p-4 font-mono text-xs leading-6 text-zinc-200 shadow-inner shadow-red-950/30 sm:text-sm">
                {translation?.text ?? t.emptyPreview}
              </pre>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function WaveformCanvas({ symbols, durationSeconds }: { symbols: number[]; durationSeconds: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    function draw() {
      if (!canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(320, Math.floor(rect.width * dpr));
      const height = Math.max(260, Math.floor(rect.height * dpr));
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      context.fillStyle = "#050303";
      context.fillRect(0, 0, width, height);

      context.globalAlpha = 0.28;
      context.strokeStyle = "#3f0b0b";
      context.lineWidth = 1;
      for (let x = 0; x < width; x += 42 * dpr) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = 0; y < height; y += 34 * dpr) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      context.globalAlpha = 1;

      if (symbols.length === 0) {
        return;
      }

      const minFrequency = GIBBERLINK_PROTOCOL.baseFrequencyHz;
      const maxFrequency = frequencyForSymbol(GIBBERLINK_PROTOCOL.symbolCount - 1);
      const columnStep = Math.max(1, Math.floor(width / Math.min(symbols.length, width)));

      for (let x = 0; x < width; x += columnStep) {
        const symbolIndex = Math.min(symbols.length - 1, Math.floor((x / width) * symbols.length));
        const frequency = frequencyForSymbol(symbols[symbolIndex] ?? 0);
        const normalized = (frequency - minFrequency) / (maxFrequency - minFrequency);
        const top = height - normalized * height * 0.86 - height * 0.06;
        const red = Math.round(120 + normalized * 135);
        context.strokeStyle = `rgba(${red}, ${Math.round(24 + normalized * 45)}, 18, 0.62)`;
        context.beginPath();
        context.moveTo(x, height);
        context.lineTo(x, top);
        context.stroke();
      }

      context.lineWidth = Math.max(2, 2 * dpr);
      context.shadowColor = "rgba(255, 42, 24, 0.75)";
      context.shadowBlur = 12 * dpr;
      context.strokeStyle = "#ff2d20";
      context.beginPath();

      const middle = height * 0.5;
      const amplitude = height * 0.22;
      for (let x = 0; x < width; x += 1) {
        const symbolIndex = Math.min(symbols.length - 1, Math.floor((x / width) * symbols.length));
        const frequency = frequencyForSymbol(symbols[symbolIndex] ?? 0);
        const angularTime = (x / width) * durationSeconds;
        const noise = Math.sin(x * 0.017) * amplitude * 0.12;
        const y = middle + Math.sin(Math.PI * 2 * frequency * angularTime) * amplitude + noise;

        if (x === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.stroke();
      context.shadowBlur = 0;

      context.fillStyle = "rgba(255,255,255,0.72)";
      context.font = `${11 * dpr}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      context.fillText(`${symbols.length} symbols · ${formatDuration(durationSeconds)}`, 16 * dpr, 26 * dpr);
    }

    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();

    return () => observer.disconnect();
  }, [symbols, durationSeconds]);

  return <canvas ref={canvasRef} className="min-h-[260px] w-full border border-red-950/80 bg-black" />;
}

function Metric({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="border border-zinc-800 bg-black/55 p-3">
      <span className="block text-[0.65rem] font-black uppercase tracking-[0.26em] text-red-400">{label}</span>
      <span className={`mt-1 block truncate text-lg font-black text-zinc-50 ${monospace ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-l-2 border-red-700 pl-4">
      <h3 className="font-black uppercase tracking-[0.18em] text-zinc-100">{title}</h3>
      <p className="mt-1 leading-6 text-zinc-400">{body}</p>
    </div>
  );
}

function buildCorpus(documents: TextDocument[]) {
  return documents
    .map(
      (document, index) =>
        `[GLNK-FILE ${index + 1}/${documents.length}: ${document.relativePath}]\n` +
        `${document.content}\n` +
        `[END-GLNK-FILE: ${document.relativePath}]`,
    )
    .join("\n\n---INFERNAL-CARRIER-GAP---\n\n");
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const payload = await safeJson<{ error?: { message?: string } }>(response);
    throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number) {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

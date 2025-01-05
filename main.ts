import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  TAbstractFile,
  Notice,
} from 'obsidian';
import { spawn } from 'child_process';
import * as path from 'path';

interface BibleReferenceSettings {
  pythonBinaryPath: string;
  passageDirectory: string;
  existingBibleFolder: string;
  debugMode: boolean;
}

const DEFAULT_SETTINGS: BibleReferenceSettings = {
  pythonBinaryPath: '/path/to/python3',
  passageDirectory: 'Bible Passages',
  existingBibleFolder: 'The Bible',
  debugMode: false,
};

const PLUGIN_DISPLAY_NAME = 'Bible Reference Plugin';
const DEBOUNCE_DELAY = 3000; // in milliseconds

interface PassageData {
  canonical: string;
  passages: string[];
  query: string;
}

export default class BibleReferencePlugin extends Plugin {
  settings: BibleReferenceSettings;
  private bibleRefRegex: RegExp;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private filesBeingModified: Set<string> = new Set();

  // Externalized datasets
  private BIBLE_STRUCTURE: { [key: string]: number[] } = {};
  private VALID_BIBLE_BOOKS: { [key: string]: string[] } = {};

  async onLayoutReady() {
    console.log(`Layout ready for ${PLUGIN_DISPLAY_NAME}...`);

    // Load settings
    await this.loadSettings();
    this.addSettingTab(new BibleReferenceSettingTab(this.app, this));

    // Load datasets
    await this.loadValidBibleBooks();
    await this.loadBibleStructure();

    // Register any additional event listeners if necessary
    this.registerFileModifyEvent();
  }

  async onload() {
    console.log(`Loading ${PLUGIN_DISPLAY_NAME}...`);

    // Enhanced Regex to match valid references like "Genesis 1:1-5" or "John 3:16"
    this.bibleRefRegex = new RegExp(
      // Optional number for books like "1 Samuel"
      '(?:\\b\\d+\\s)?' +
        // Book name (allowing letters, spaces, and periods for abbreviations)
        '[A-Za-z. ]+' +
        '\\s+' +
        // Chapter number
        '\\d+' +
        // Verse range or single verse
        '(?::\\d+)' +
        // Optional verse range
        '(?:\\s?-\\s?(\\d+))?',
      'i'
    );

    this.app.workspace.onLayoutReady(() => this.onLayoutReady());
  }

  onunload() {
    console.log(`Unloading ${PLUGIN_DISPLAY_NAME}...`);
  }

  async loadSettings() {
    const loadedData = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...loadedData };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private debugLog(message: string) {
    if (this.settings.debugMode) {
      console.log(`[DEBUG] ${message}`);
    }
  }

  public async loadValidBibleBooks() {
    try {
      const pluginDir = this.app.vault.configDir; // This points to .obsidian directory
      const filePath = `${pluginDir}/plugins/${this.manifest.id}/valid_bible_books.json`;

      const content = await this.app.vault.adapter.read(filePath);
      this.VALID_BIBLE_BOOKS = JSON.parse(content);

      console.log('VALID_BIBLE_BOOKS loaded successfully:', this.VALID_BIBLE_BOOKS);
    } catch (error) {
      console.error('Error loading valid_bible_books.json:', error);
      new Notice(`Failed to load "valid_bible_books.json". Ensure the file exists in the plugin's directory.`);
    }
  }

  public async loadBibleStructure() {
    try {
      const pluginDir = this.app.vault.configDir; // This points to .obsidian directory
      const filePath = `${pluginDir}/plugins/${this.manifest.id}/bible_structure.json`;

      const content = await this.app.vault.adapter.read(filePath);
      this.BIBLE_STRUCTURE = JSON.parse(content);

      console.log('BIBLE_STRUCTURE loaded successfully:', this.BIBLE_STRUCTURE);
    } catch (error) {
      console.error('Error loading bible_structure.json:', error);
      new Notice(`Failed to load "bible_structure.json". Ensure the file exists in the plugin's directory.`);
    }
  }

  private registerFileModifyEvent() {
    this.registerEvent(
      this.app.vault.on('modify', async (file: TAbstractFile) => {
        if (file instanceof TFile) {
          this.debugLog(`Modify event detected for file: ${file.path}`);

          // Prevent processing files being modified by the plugin itself
          if (this.filesBeingModified.has(file.path)) {
            this.debugLog(`Skipping processing for file "${file.path}" as it's being modified by the plugin.`);
            return;
          }

          // Implement debounce to prevent excessive triggering
          if (this.debounceTimers.has(file.path)) {
            clearTimeout(this.debounceTimers.get(file.path)!);
          }

          const timer = setTimeout(async () => {
            this.debounceTimers.delete(file.path);
            await this.processFileReferences(file, 'File Saved');
          }, DEBOUNCE_DELAY);

          this.debounceTimers.set(file.path, timer);
        }
      })
    );
  }

  private async processFileReferences(file: TFile, eventSource: string) {
    this.debugLog(`Processing references triggered by: ${eventSource} for file "${file.path}"`);
    try {
      const content = await this.app.vault.read(file);

      // Regex for [[some text]], capturing the inside
      const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let match;
      const referencesToProcess: string[] = [];
      const illegalReferences: string[] = [];

      while ((match = wikiLinkRegex.exec(content)) !== null) {
        const reference = match[1].trim();
        if (this.bibleRefRegex.test(reference)) {
          if (this.isValidReference(reference)) {
            this.debugLog(`Valid Bible reference found in "${file.basename}": ${reference}`);
            referencesToProcess.push(reference);
          } else {
            this.debugLog(`Illegal Bible reference detected in "${file.basename}": ${reference}`);
            illegalReferences.push(reference);
          }
        }
      }

      // Handle illegal references
      if (illegalReferences.length > 0) {
        new Notice(`Found ${illegalReferences.length} illegal Bible reference(s) in "${file.basename}". Check console for details.`);
        if (this.settings.debugMode) {
          console.warn(`Illegal Bible references in "${file.path}":`, illegalReferences);
        }
      }

      if (referencesToProcess.length === 0) {
        this.debugLog(`No valid Bible references to process in "${file.path}".`);
        return;
      }

      // Remove duplicate references
      const uniqueReferences = Array.from(new Set(referencesToProcess));

      let updatedContent = content;
      for (const reference of uniqueReferences) {
        const parsedRef = this.parseReference(reference);
        if (!parsedRef) {
          continue; // or handle error
        }
        const { bookNumber, bookName, chapter, startVerse, endVerse } = parsedRef;
        const normalizedBookName = this.normalizeBookName(bookNumber, bookName);
        if (!normalizedBookName) {
          this.debugLog(`Failed to find long-form name for book: "${bookNumber ? `${bookNumber} ` : ''}${bookName}"`);
          continue;
        }
        const isSingleVerse = !endVerse;

        let linkTarget;
        if (isSingleVerse) {
          // For single verse references, link to chapter file with verse heading
          linkTarget = `${normalizedBookName} ${chapter}#^v${startVerse}`;

          // Since we're using an existing chapter file, we don't need to create a passage note
        } else {
          const normalizedReference = this.normalizeToLongForm(reference);
          const canonicalRef = normalizedReference.replace(':', '-');
          linkTarget = canonicalRef;

          // For passages, get or create the passage note
          await this.getOrCreatePassage(reference);
        }

        // Now perform the replacement
        const escapedReference = this.escapeRegExp(reference);
        const regex = new RegExp(`\\[\\[${escapedReference}\\]\\]`, 'g');
        updatedContent = updatedContent.replace(regex, `[[${linkTarget}|${reference}]]`);
      }

      if (updatedContent !== content) {
        this.filesBeingModified.add(file.path);
        await this.app.vault.modify(file, updatedContent);
        this.filesBeingModified.delete(file.path);
        this.debugLog(`Updated references in file "${file.path}".`);
        new Notice(`Updated Bible references in "${file.basename}".`);
      }
    } catch (error) {
      console.error(`Error processing file references for "${file.path}":`, error);
      new Notice(`Error processing Bible references in "${file.basename}". Check console for details.`);
    }
  }

  private isValidReference(reference: string): boolean {
    const parsedRef = this.parseReference(reference);
    if (!parsedRef) {
      return false;
    }

    const { bookNumber, bookName, chapter, startVerse, endVerse } = parsedRef;

    // Normalize the book name for validation
    const normalizedBookName = this.normalizeBookName(bookNumber, bookName);
    this.debugLog(`Normalized book name: "${normalizedBookName}"`);

    if (!normalizedBookName) {
      this.debugLog(`Book name "${normalizedBookName}" is not valid.`);
      return false;
    }

    // Check if the book exists in the BIBLE_STRUCTURE dataset
    if (!this.BIBLE_STRUCTURE[normalizedBookName]) {
      this.debugLog(`Book "${normalizedBookName}" not found in BIBLE_STRUCTURE dataset.`);
      return false;
    }

    // Log the number of chapters
    const totalChapters = this.BIBLE_STRUCTURE[normalizedBookName].length;
    this.debugLog(`Book "${normalizedBookName}" has ${totalChapters} chapters.`);

    // Basic numerical validation
    const chapNum = parseInt(chapter, 10);
    const startVes = parseInt(startVerse, 10);
    const endVes = endVerse ? parseInt(endVerse, 10) : startVes;

    if (isNaN(chapNum) || isNaN(startVes) || isNaN(endVes)) {
      this.debugLog(`Reference "${reference}" contains invalid numbers.`);
      return false;
    }

    // Ensure that the chapter exists
    if (chapNum < 1 || chapNum > totalChapters) {
      this.debugLog(`Chapter ${chapNum} does not exist in "${normalizedBookName}".`);
      return false;
    }

    // Ensure that the start verse exists
    const chapterVerseCount = this.BIBLE_STRUCTURE[normalizedBookName][chapNum - 1];
    this.debugLog(`Book "${normalizedBookName}" Chapter ${chapNum} has ${chapterVerseCount} verses.`);
    if (startVes < 1 || startVes > chapterVerseCount) {
      this.debugLog(`Start verse ${startVes} does not exist in "${normalizedBookName}" Chapter ${chapNum}.`);
      return false;
    }

    // Ensure that the end verse exists
    if (endVes < startVes || endVes > chapterVerseCount) {
      this.debugLog(`End verse ${endVes} is invalid in "${normalizedBookName}" Chapter ${chapNum}.`);
      return false;
    }

    return true;
  }

  private normalizeBookName(bookNumber: string | undefined, bookName: string): string | null {
    const trimmedName = bookName.replace(/\.$/, '').trim(); // Remove trailing period and trim
    let normalized: string | null = null;

    for (const [longForm, aliases] of Object.entries(this.VALID_BIBLE_BOOKS)) {
      if (
        longForm.toLowerCase() === `${bookNumber ? bookNumber + ' ' : ''}${trimmedName}`.toLowerCase() ||
        aliases.some(
          (alias) =>
            alias.toLowerCase() === `${bookNumber ? bookNumber + ' ' : ''}${trimmedName}`.toLowerCase()
        )
      ) {
        normalized = longForm; // Convert to long-form name
        break;
      }
    }

    if (!normalized) {
      this.debugLog(`No matching long-form name found for book name: "${bookNumber ? `${bookNumber} ` : ''}${bookName}".`);
      return null;
    }

    return normalized;
  }

  private normalizeToLongForm(reference: string): string | null {
    const parsedRef = this.parseReference(reference);
    if (!parsedRef) {
      return null;
    }

    const { bookNumber, bookName, chapter, startVerse, endVerse } = parsedRef;

    const normalizedBookName = this.normalizeBookName(bookNumber, bookName);
    if (!normalizedBookName) {
      this.debugLog(`Failed to find long-form name for book: "${bookNumber ? `${bookNumber} ` : ''}${bookName}"`);
      return null;
    }

    let normalizedReference;
    if (endVerse) {
      normalizedReference = `${normalizedBookName} ${chapter}:${startVerse}-${endVerse}`;
    } else {
      normalizedReference = `${normalizedBookName} ${chapter}:${startVerse}`;
    }

    return normalizedReference.trim();
  }

  private parseReference(
    reference: string
  ): {
    bookNumber?: string;
    bookName: string;
    chapter: string;
    startVerse: string;
    endVerse?: string;
  } | null {
    const refRegex = /^(?:(\d+)\s)?([A-Za-z. ]+)\s+(\d+):(\d+)(?:\s?-\s?(\d+))?$/;
    const match = reference.match(refRegex);

    if (!match) {
      this.debugLog(`Reference does not match expected format: "${reference}"`);
      return null;
    }

    const [, bookNumber, bookName, chapter, startVerse, endVerse] = match;

    return {
      bookNumber,
      bookName,
      chapter,
      startVerse,
      endVerse,
    };
  }

  private async getOrCreatePassage(reference: string) {
    try {
      const normalizedReference = this.normalizeToLongForm(reference);

      // 1. Check if an existing note by this name is in existingBibleFolder
      const existingFile = this.findFileInFolder(this.settings.passageDirectory, normalizedReference);
      if (existingFile) {
        this.debugLog(`Passage note already exists: "${existingFile.path}".`);
        return;
      }

      // 2. If not found, create a new note in passageDirectory
      await this.ensureFolderExists(this.settings.passageDirectory);

      // 3. Run Python script to fetch passage data
      const passageData = await this.fetchPassage(normalizedReference);
      if (!passageData) {
        this.debugLog(`No passage data returned for "${reference}".`);
        new Notice(`Failed to fetch passage for "${reference}".`);
        return;
      }

      // 4. Replace ":" with "-" in the canonical reference for the file name
      const canonicalRef = passageData.canonical.replace(':', '-');

      if (!canonicalRef) {
        this.debugLog(`No valid canonical reference returned for "${reference}".`);
        new Notice(`Invalid reference format for "${reference}".`);
        return;
      }

      // 5. Define the path for the new file
      const canonicalPath = `${this.settings.passageDirectory}/${canonicalRef}.md`;

      // Parse the reference to generate verse links
      const parsedRef = this.parseReference(normalizedReference);
      if (!parsedRef) {
        // Handle error
        this.debugLog(`Failed to parse reference "${normalizedReference}" for verse links.`);
        return;
      }
      const { bookNumber, bookName, chapter, startVerse, endVerse } = parsedRef;
      const normalizedBookName = this.normalizeBookName(bookNumber, bookName);
      if (!normalizedBookName) {
        this.debugLog(`Failed to normalize book name for "${bookNumber ? bookNumber + ' ' : ''}${bookName}".`);
        return;
      }

      // Generate verse links
      let verseLinks = '';
      if (chapter && startVerse) {
        const startVerseNum = parseInt(startVerse, 10);
        const endVerseNum = endVerse ? parseInt(endVerse, 10) : startVerseNum;

        const links = [];
        for (let v = startVerseNum; v <= endVerseNum; v++) {
          links.push(`[[${normalizedBookName} ${chapter}#^v${v}]]`);
        }
        verseLinks = links.join(' ');
      }

      // 6. Prepare the content
      const content = this.formatNoteContent(passageData, normalizedReference, verseLinks);

      // 7. Write the new file
      await this.app.vault.create(canonicalPath, content);
      this.debugLog(`Created passage note: ${canonicalPath}`);
      new Notice(`Created passage note for "${reference}".`);
    } catch (error) {
      console.error(`Error in getOrCreatePassage for "${reference}":`, error);
      new Notice(`Error creating passage note for "${reference}".`);
    }
  }

  private findFileInFolder(folderPath: string, reference: string): TFile | null {
    const targetBasename = reference.replace(':', '-');

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) {
      this.debugLog(`Folder not found or not a folder: "${folderPath}".`);
      return null;
    }

    const files = this.getAllFilesInFolder(folder);
    for (const file of files) {
      if (file.basename === targetBasename) {
        return file;
      }
    }
    return null;
  }

  private getAllFilesInFolder(folder: TFolder): TFile[] {
    let results: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        results.push(child);
      } else if (child instanceof TFolder) {
        results = results.concat(this.getAllFilesInFolder(child));
      }
    }
    return results;
  }

  private async ensureFolderExists(folderPath: string) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      this.debugLog(`Creating folder: "${folderPath}".`);
      await this.app.vault.createFolder(folderPath);
    }
  }

  private async fetchPassage(reference: string): Promise<PassageData | null> {
    const pythonExe = this.settings.pythonBinaryPath || 'python3';
    const vaultDir = (this.app.vault.adapter as any).basePath; // Full absolute path to the vault
    const scriptPath = path.resolve(vaultDir, '.obsidian', 'plugins', this.manifest.id, 'bible_parser.py');

    return new Promise((resolve, reject) => {
      this.debugLog(`Running Python script: "${scriptPath}" with reference: "${reference}"`);

      const child = spawn(pythonExe, [scriptPath, reference]);

      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        this.debugLog(`Failed to start Python script: ${err.message}`);
        reject(null);
      });

      child.on('close', (code) => {
        this.debugLog(`Python script exited with code: ${code}`);
        if (code !== 0) {
          console.error(`Error running Python script:\n${stderrData}`);
          reject(null);
          return;
        }

        // Parse output lines (simple text-based approach)
        const lines = stdoutData.split('\n').map((l) => l.trim()).filter(Boolean);
        const verseStrings: string[] = [];

        for (const line of lines) {
          if (line.startsWith('SUBTITLE:')) {
            const subtitle = line.replace('SUBTITLE:', '').trim();
            verseStrings.push(`## ${subtitle}`);
          } else if (line.startsWith('VERSE ')) {
            const match = line.match(/^VERSE\s+(\d+):\s*(.*)$/);
            if (match) {
              const verseNum = match[1];
              const verseText = match[2];
              verseStrings.push(`${verseNum}. ${verseText}`);
            }
          } else {
            verseStrings.push(line);
          }
        }

        // Replace ":" with "-" in the canonical reference
        const canonicalRef = reference.replace(':', '-');
        resolve({
          canonical: canonicalRef,
          passages: [verseStrings.join('\n')],
          query: reference,
        });
      });
    });
  }

  // **Modified formatNoteContent function**
  private formatNoteContent(passageData: PassageData, userQuery: string, verseLinks?: string): string {
    const canonical = passageData.canonical ?? '';
    const aliases = new Set([canonical, passageData.query, userQuery]);

    return `---
aliases: [${Array.from(aliases).map((alias) => `"${alias}"`).join(', ')}]
cssclasses: 'bible_reference'
---

${passageData.passages?.join('\n') ?? ''}

${verseLinks ? '\n' + verseLinks : ''}
`;
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

class BibleReferenceSettingTab extends PluginSettingTab {
  plugin: BibleReferencePlugin;

  constructor(app: App, plugin: BibleReferencePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h1', { text: `${PLUGIN_DISPLAY_NAME} Settings` });

    new Setting(containerEl)
      .setName('Python Binary Path')
      .setDesc('Path to the Python interpreter. (e.g., /usr/bin/python3)')
      .addText((text) =>
        text
          .setPlaceholder('python3')
          .setValue(this.plugin.settings.pythonBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonBinaryPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Passage Note Directory')
      .setDesc('Folder where new notes are created (if none found).')
      .addText((txt) =>
        txt
          .setValue(this.plugin.settings.passageDirectory)
          .onChange(async (value) => {
            this.plugin.settings.passageDirectory = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Existing Bible Folder')
      .setDesc('Folder containing chapter-based Bible notes.')
      .addText((txt) =>
        txt
          .setPlaceholder('Sources/The Bible')
          .setValue(this.plugin.settings.existingBibleFolder)
          .onChange(async (value) => {
            this.plugin.settings.existingBibleFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Debug Mode')
      .setDesc('If enabled, prints debug logs to console.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
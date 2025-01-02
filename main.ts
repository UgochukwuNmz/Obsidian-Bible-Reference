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

/**
 * Configuration interface for the Bible Reference plugin.
 */
interface BibleReferenceSettings {
  pythonBinaryPath: string;
  bibleParserScriptPath: string;

  passageDirectory: string;
  debugMode: boolean;
  existingBibleFolder: string;

  validBibleBooksPath: string;
  bibleStructurePath: string;
}

const DEFAULT_SETTINGS: BibleReferenceSettings = {
  pythonBinaryPath: '/path/to/python3', // Update as needed
  bibleParserScriptPath: '/path/to/bible_parser.py', // Update as needed

  passageDirectory: 'Bible Passages',
  debugMode: false,
  existingBibleFolder: 'Sources/The Bible',

  validBibleBooksPath: 'Utility/valid_bible_books.json',
  bibleStructurePath: 'Utility/bible_structure.json',
};


const PLUGIN_DISPLAY_NAME = 'Bible Reference Plugin';
const DEBOUNCE_DELAY = 3000; // in milliseconds

/**
 * Interface for structured passage data.
 */
interface PassageData {
  canonical: string;
  passages: string[];
  query: string;
}

/**
 * Main plugin class.
 */
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
        // Optional range with chapter and verse or just verse
        '(?:\\s?-\\s?(?:(\\d+):)?(\\d+))?',
      'i'
    );

    this.app.workspace.onLayoutReady(() => this.onLayoutReady());
  }

  onunload() {
    console.log(`Unloading ${PLUGIN_DISPLAY_NAME}...`);
  }

  /**
   * Loads settings from the plugin’s data.json file.
   */
  async loadSettings() {
    const loadedData = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...loadedData };
  }

  /**
   * Saves the current settings to the plugin’s data.json file.
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Prints a debug message to the console if debug mode is enabled.
   */
  private debugLog(message: string) {
    if (this.settings.debugMode) {
      console.log(`[DEBUG] ${message}`);
    }
  }

  /**
   * Loads the VALID_BIBLE_BOOKS dataset from an external JSON file.
   */
  public async loadValidBibleBooks() {
    const filePath = this.settings.validBibleBooksPath;
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file && file instanceof TFile) {
        const content = await this.app.vault.read(file);
        this.VALID_BIBLE_BOOKS = JSON.parse(content);
        this.debugLog('VALID_BIBLE_BOOKS loaded successfully.');
        
        // Log all loaded book names
        const loadedBooks = Object.keys(this.VALID_BIBLE_BOOKS);
        this.debugLog(`Loaded VALID_BIBLE_BOOKS: ${loadedBooks.join(', ')}`);
      } else {
        this.debugLog(`valid_bible_books.json not found at path: "${filePath}".`);
        new Notice(`Bible book aliases data not found. Please ensure "valid_bible_books.json" is placed correctly.`);
      }
    } catch (error) {
      console.error('Error loading valid_bible_books.json:', error);
      this.debugLog('Failed to load VALID_BIBLE_BOOKS.');
      new Notice(`Failed to load Bible book aliases. Check console for details.`);
    }
  }


  /**
   * Loads the BIBLE_STRUCTURE dataset from an external JSON file.
   */
  public async loadBibleStructure() {
    const structurePath = this.settings.bibleStructurePath;
    try {
      const file = this.app.vault.getAbstractFileByPath(structurePath);
      if (file && file instanceof TFile) {
        const content = await this.app.vault.read(file);
        this.BIBLE_STRUCTURE = JSON.parse(content);
        this.debugLog('BIBLE_STRUCTURE loaded successfully.');
        
        // Log all loaded book names
        const loadedBooks = Object.keys(this.BIBLE_STRUCTURE);
        this.debugLog(`Loaded BIBLE_STRUCTURE: ${loadedBooks.join(', ')}`);
      } else {
        this.debugLog(`bible_structure.json not found at path: "${structurePath}".`);
        new Notice(`Bible structure data not found. Please ensure "bible_structure.json" is placed correctly.`);
      }
    } catch (error) {
      console.error('Error loading bible_structure.json:', error);
      this.debugLog('Failed to load BIBLE_STRUCTURE.');
      new Notice(`Failed to load Bible structure data. Check console for details.`);
    }
  }

  /* ---------------------------------------------------------------------------
   * Event Registrations
   * -------------------------------------------------------------------------*/

  /**
   * Trigger on file "modify" (which corresponds to save).
   */
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

  /* ---------------------------------------------------------------------------
   * Core Reference Processing
   * -------------------------------------------------------------------------*/

  /**
   * Scans the file for wiki links like [[John 3:16]] or [[Genesis 1:1]].
   * If a match is found that looks like a Bible reference, create or link the passage note.
   */
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

      for (const reference of uniqueReferences) {
        await this.getOrCreatePassage(reference);
      }

      // Now perform the replacements
      let updatedContent = content;
      for (const reference of uniqueReferences) {
        const canonicalRef = reference.replace(':', '-');
        const escapedReference = this.escapeRegExp(reference);
        const regex = new RegExp(`\\[\\[${escapedReference}\\]\\]`, 'g');
        updatedContent = updatedContent.replace(regex, `[[${canonicalRef}|${reference}]]`);
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

  /**
   * Validates the Bible reference to ensure it follows proper syntax, has a valid book name,
   * and that the specified chapters and verses exist within the book.
   * For example, ensures that ranges include both chapter and verse if necessary.
   */
  private isValidReference(reference: string): boolean {
    // Split the reference into parts using the existing regex
    const refRegex = /^(?:(\d+)\s)?([A-Za-z. ]+)\s+(\d+):(\d+)(?:\s?-\s?(?:(\d+):)?(\d+))?$/;
    const match = reference.match(refRegex);
    if (!match) {
      this.debugLog(`Reference "${reference}" does not match the regex.`);
      return false;
    }

    const [
      ,
      bookNumber,
      bookName,
      startChapter,
      startVerse,
      endChapter,
      endVerse,
    ] = match;

    // Normalize the book name for validation
    const normalizedBookName = this.normalizeBookName(bookNumber, bookName);
    this.debugLog(`Normalized book name: "${normalizedBookName}"`);

    if (!this.isValidBookName(normalizedBookName)) {
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
    const startChap = parseInt(startChapter, 10);
    const startVes = parseInt(startVerse, 10);
    const endChap = endChapter ? parseInt(endChapter, 10) : startChap;
    const endVes = endVerse ? parseInt(endVerse, 10) : startVes;

    if (isNaN(startChap) || isNaN(startVes) || isNaN(endChap) || isNaN(endVes)) {
      this.debugLog(`Reference "${reference}" contains invalid numbers.`);
      return false;
    }

    // Ensure that the start chapter exists
    if (startChap < 1 || startChap > totalChapters) {
      this.debugLog(`Start chapter ${startChap} does not exist in "${normalizedBookName}".`);
      return false;
    }

    // Ensure that the start verse exists
    const startChapterVerseCount = this.BIBLE_STRUCTURE[normalizedBookName][startChap - 1];
    this.debugLog(`Book "${normalizedBookName}" Chapter ${startChap} has ${startChapterVerseCount} verses.`);
    if (startVes < 1 || startVes > startChapterVerseCount) {
      this.debugLog(`Start verse ${startVes} does not exist in "${normalizedBookName}" Chapter ${startChap}.`);
      return false;
    }

    // Ensure that the end chapter exists
    if (endChap < startChap || endChap > totalChapters) {
      this.debugLog(`End chapter ${endChap} does not exist in "${normalizedBookName}".`);
      return false;
    }

    // Ensure that the end verse exists
    const endChapterVerseCount = this.BIBLE_STRUCTURE[normalizedBookName][endChap - 1];
    this.debugLog(`Book "${normalizedBookName}" Chapter ${endChap} has ${endChapterVerseCount} verses.`);
    if (endVes < 1 || endVes > endChapterVerseCount) {
      this.debugLog(`End verse ${endVes} does not exist in "${normalizedBookName}" Chapter ${endChap}.`);
      return false;
    }

    // If the range spans the same chapter, ensure end verse >= start verse
    if (endChap === startChap && endVes < startVes) {
      this.debugLog(`End verse ${endVes} is less than start verse ${startVes} in Chapter ${startChap}.`);
      return false;
    }

    return true;
  }

/**
 * Normalizes the book name by combining the numerical prefix (if any) with the book name
 * and converting shorthand names to their long-form equivalents.
 * For example, ("1", "Samuel") => "1 Samuel", or ("", "Gen") => "Genesis".
 */
  private normalizeBookName(bookNumber: string | undefined, bookName: string): string | null {
    const trimmedName = bookName.replace(/\.$/, '').trim(); // Remove trailing period and trim
    let normalized = trimmedName;

    // Check if the book name is a shorthand and map it to the long-form
    for (const [longForm, aliases] of Object.entries(this.VALID_BIBLE_BOOKS)) {
      if (longForm.toLowerCase() === trimmedName.toLowerCase() || aliases.some(alias => alias.toLowerCase() === trimmedName.toLowerCase())) {
        normalized = longForm; // Convert to long-form name
        break;
      }
    }

    // Combine with book number if provided
    if (bookNumber) {
      return `${bookNumber} ${normalized}`;
    }

    if (!normalized) {
      this.debugLog(`No matching long-form name found for "${bookName}".`);
      return null; // Return null if no match is found
    }

    return normalized;
  }


  /**
   * Checks if the provided book name is a valid Bible book.
   * Supports both full names and common abbreviations.
   */
  private isValidBookName(bookName: string): boolean {
    // Iterate through each book and its aliases
    for (const [standardName, aliases] of Object.entries(this.VALID_BIBLE_BOOKS)) {
      this.debugLog(`Checking aliases for book "${standardName}": ${aliases.join(', ')}`);
      for (const alias of aliases) {
        if (alias.toLowerCase() === bookName.toLowerCase()) {
          this.debugLog(`Match found: "${alias}" matches "${bookName}"`);
          return true;
        }
      }
    }
    this.debugLog(`No matching aliases found for book "${bookName}"`);
    return false;
  }

  /**
   * Checks if a note already exists in the user-chosen "existingBibleFolder".
   * If not, creates one in "passageDirectory" using data from the Python script.
   */
  private async getOrCreatePassage(reference: string) {
    try {
      // 1. Check if an existing note by this name is in existingBibleFolder
      const existingFile = this.findFileInFolder(this.settings.existingBibleFolder, reference);
      if (existingFile) {
        this.debugLog(`Found existing note for "${reference}" at "${existingFile.path}".`);
        return;
      }

      // 2. If not found, create a new note in passageDirectory
      await this.ensureFolderExists(this.settings.passageDirectory);

      // 3. Run Python script to fetch passage data
      const passageData = await this.fetchPassage(reference);
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

      // 6. Prepare the content
      const content = this.formatNoteContent(passageData, reference);

      // 7. Write the new file
      await this.app.vault.create(canonicalPath, content);
      this.debugLog(`Created passage note: ${canonicalPath}`);
      new Notice(`Created passage note for "${reference}".`);
    } catch (error) {
      console.error(`Error in getOrCreatePassage for "${reference}":`, error);
      new Notice(`Error creating passage note for "${reference}".`);
    }
  }

  /**
   * Finds a file whose base name matches the reference (with ":" replaced by "-")
   * within the specified folder path.
   */
  private findFileInFolder(folderPath: string, reference: string): TFile | null {
    const targetBasename = reference.replace(':', '-');

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) {
      this.debugLog(`Folder not found or not a folder: "${folderPath}".`);
      return null;
    }

    // Recursively search all files in that folder
    const files = this.getAllFilesInFolder(folder);
    for (const file of files) {
      if (file.basename === targetBasename) {
        return file;
      }
    }
    return null;
  }

  /**
   * Recursively gathers all TFile objects within a TFolder.
   */
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

  /**
   * Ensures the user-specified folder exists. If not, creates it.
   */
  private async ensureFolderExists(folderPath: string) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      this.debugLog(`Creating folder: "${folderPath}".`);
      await this.app.vault.createFolder(folderPath);
    }
  }

  /* ---------------------------------------------------------------------------
   * Python Script Integration
   * -------------------------------------------------------------------------*/

  /**
   * Spawns the python script with the given reference, then parses and returns
   * the passage data.
   */
  private async fetchPassage(reference: string): Promise<PassageData | null> {
    const pythonExe = this.settings.pythonBinaryPath || 'python3';
    const scriptPath = this.settings.bibleParserScriptPath;

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

  /**
   * Formats the passage data into Markdown with frontmatter aliases.
   */
  private formatNoteContent(passageData: PassageData, userQuery: string): string {
    const canonical = passageData.canonical ?? '';
    const aliases = new Set([canonical, passageData.query, userQuery]);

    return `---
aliases: [${Array.from(aliases).map((alias) => `"${alias}"`).join(', ')}]
cssclasses: 'bible_reference'
---
    
${passageData.passages?.join('\n') ?? ''}
`;
  }

  /**
   * Escapes special characters in a string for use in a regular expression.
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Plugin Setting Tab for the Bible Reference plugin.
 */
class BibleReferenceSettingTab extends PluginSettingTab {
  plugin: BibleReferencePlugin;

  constructor(app: App, plugin: BibleReferencePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Renders the plugin's settings UI.
   */
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
      .setName('Path to bible_parser.py')
      .setDesc('Absolute path to your "bible_parser.py" script.')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/bible_parser.py')
          .setValue(this.plugin.settings.bibleParserScriptPath)
          .onChange(async (value) => {
            this.plugin.settings.bibleParserScriptPath = value.trim();
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

    new Setting(containerEl)
      .setName('Path to valid_bible_books.json')
      .setDesc('Relative path within your vault to "valid_bible_books.json".')
      .addText((text) =>
        text
          .setPlaceholder('valid_bible_books.json')
          .setValue(this.plugin.settings.validBibleBooksPath)
          .onChange(async (value) => {
            this.plugin.settings.validBibleBooksPath = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.loadValidBibleBooks();
          })
      );

    new Setting(containerEl)
      .setName('Path to bible_structure.json')
      .setDesc('Relative path within your vault to "bible_structure.json".')
      .addText((text) =>
        text
          .setPlaceholder('bible_structure.json')
          .setValue(this.plugin.settings.bibleStructurePath)
          .onChange(async (value) => {
            this.plugin.settings.bibleStructurePath = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.loadBibleStructure();
          })
      );
  }
}

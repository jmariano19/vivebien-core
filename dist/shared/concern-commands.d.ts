/**
 * WhatsApp-native concern management commands
 * Detects and parses merge, delete, and rename operations from user messages
 * Supports 4 languages: EN, ES, PT, FR
 */
export interface ConcernCommand {
    type: 'merge' | 'delete' | 'rename';
    targets: string[];
    newName?: string;
    language: string;
}
/**
 * Detects concern management commands from user WhatsApp messages.
 * Uses natural-language regex patterns specific to each command type and language.
 *
 * Returns a parsed command object if a command pattern is detected, null otherwise.
 */
export declare function detectConcernCommand(message: string, language: string): ConcernCommand | null;
/**
 * Returns a localized confirmation message for a successfully executed command.
 * Uses the affected concern names to provide specific feedback.
 */
export declare function getCommandConfirmationMessage(command: ConcernCommand, affectedNames: string[]): string;
/**
 * Returns a localized error message when a command cannot be executed
 * (e.g., concern not found, invalid input).
 */
export declare function getCommandErrorMessage(language: string): string;
//# sourceMappingURL=concern-commands.d.ts.map
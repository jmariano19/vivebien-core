"use strict";
/**
 * WhatsApp-native concern management commands
 * Detects and parses merge, delete, and rename operations from user messages
 * Supports 4 languages: EN, ES, PT, FR
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectConcernCommand = detectConcernCommand;
exports.getCommandConfirmationMessage = getCommandConfirmationMessage;
exports.getCommandErrorMessage = getCommandErrorMessage;
/**
 * Detects concern management commands from user WhatsApp messages.
 * Uses natural-language regex patterns specific to each command type and language.
 *
 * Returns a parsed command object if a command pattern is detected, null otherwise.
 */
function detectConcernCommand(message, language) {
    const normalized = message.trim();
    const lower = normalized.toLowerCase();
    // Try to detect each command type in the user's language
    const mergeCommand = detectMergeCommand(normalized, lower, language);
    if (mergeCommand)
        return mergeCommand;
    const deleteCommand = detectDeleteCommand(normalized, lower, language);
    if (deleteCommand)
        return deleteCommand;
    const renameCommand = detectRenameCommand(normalized, lower, language);
    if (renameCommand)
        return renameCommand;
    return null;
}
/**
 * Detects merge commands: "merge X and Y", "combine X with Y", "X is part of Y", "X is the same as Y"
 */
function detectMergeCommand(message, lower, language) {
    let patterns;
    switch (language) {
        case 'es':
            patterns = [
                /^(?:por favor\s+)?(?:combinar|mezclar)\s+([^y]+?)\s+y\s+(.+?)(?:\s+por favor)?\.?$/i,
                /^(?:por favor\s+)?(.+?)\s+(?:es\s+parte\s+de|es\s+lo\s+mismo\s+que)\s+(.+?)(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'pt':
            patterns = [
                /^(?:por favor\s+)?(?:combinar|mesclar)\s+([^e]+?)\s+e\s+(.+?)(?:\s+por favor)?\.?$/i,
                /^(?:por favor\s+)?(.+?)\s+(?:é\s+parte\s+de|é\s+o\s+mesmo\s+que)\s+(.+?)(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'fr':
            patterns = [
                /^(?:s'il vous plaît\s+)?(?:fusionner|combiner)\s+([^e]+?)\s+et\s+(.+?)(?:\s+s'il vous plaît)?\.?$/i,
                /^(?:s'il vous plaît\s+)?(.+?)\s+(?:fait partie de|est le même que)\s+(.+?)(?:\s+s'il vous plaît)?\.?$/i,
            ];
            break;
        case 'en':
        default:
            patterns = [
                /^(?:please\s+)?(?:merge|combine)\s+([^a]+?)\s+(?:and|with)\s+(.+?)(?:\s+please)?\.?$/i,
                /^(?:please\s+)?(.+?)\s+(?:is\s+part\s+of|is\s+the\s+same\s+as)\s+(.+?)(?:\s+please)?\.?$/i,
            ];
            break;
    }
    for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (match && match[1] && match[2]) {
            const first = match[1].trim();
            const second = match[2].trim();
            // Filter out empty strings
            if (first.length > 0 && second.length > 0) {
                return {
                    type: 'merge',
                    targets: [first, second],
                    language,
                };
            }
        }
    }
    return null;
}
/**
 * Detects delete commands: "delete X", "remove X", "delete X concern/note/entry"
 */
function detectDeleteCommand(message, lower, language) {
    let patterns;
    switch (language) {
        case 'es':
            patterns = [
                /^(?:por favor\s+)?(?:eliminar|borrar)\s+(.+?)(?:\s+(?:preocupación|nota|entrada))?(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'pt':
            patterns = [
                /^(?:por favor\s+)?(?:deletar|remover)\s+(.+?)(?:\s+(?:preocupação|nota|entrada))?(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'fr':
            patterns = [
                /^(?:s'il vous plaît\s+)?(?:supprimer|effacer)\s+(.+?)(?:\s+(?:préoccupation|note|entrée))?(?:\s+s'il vous plaît)?\.?$/i,
            ];
            break;
        case 'en':
        default:
            patterns = [
                /^(?:please\s+)?(?:delete|remove)\s+(.+?)(?:\s+(?:concern|note|entry))?(?:\s+please)?\.?$/i,
            ];
            break;
    }
    for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (match && match[1]) {
            const target = match[1]
                .replace(/\b(?:concern|note|entry|preocupación|nota|entrada|préoccupation|entrée)\b/gi, '')
                .trim();
            if (target.length > 0) {
                return {
                    type: 'delete',
                    targets: [target],
                    language,
                };
            }
        }
    }
    return null;
}
/**
 * Detects rename commands: "rename X to Y", "change X to Y"
 */
function detectRenameCommand(message, lower, language) {
    let patterns;
    switch (language) {
        case 'es':
            patterns = [
                /^(?:por favor\s+)?(?:renombrar|cambiar)\s+(.+?)\s+a\s+(.+?)(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'pt':
            patterns = [
                /^(?:por favor\s+)?(?:renomear|mudar)\s+(.+?)\s+para\s+(.+?)(?:\s+por favor)?\.?$/i,
            ];
            break;
        case 'fr':
            patterns = [
                /^(?:s'il vous plaît\s+)?(?:renommer|changer)\s+(.+?)\s+en\s+(.+?)(?:\s+s'il vous plaît)?\.?$/i,
            ];
            break;
        case 'en':
        default:
            patterns = [
                /^(?:please\s+)?(?:rename|change)\s+(.+?)\s+to\s+(.+?)(?:\s+please)?\.?$/i,
            ];
            break;
    }
    for (const pattern of patterns) {
        const match = lower.match(pattern);
        if (match && match[1] && match[2]) {
            const oldName = match[1].trim();
            const newName = match[2].trim();
            if (oldName.length > 0 && newName.length > 0) {
                return {
                    type: 'rename',
                    targets: [oldName],
                    newName,
                    language,
                };
            }
        }
    }
    return null;
}
/**
 * Returns a localized confirmation message for a successfully executed command.
 * Uses the affected concern names to provide specific feedback.
 */
function getCommandConfirmationMessage(command, affectedNames) {
    if (affectedNames.length === 0) {
        return getCommandErrorMessage(command.language);
    }
    switch (command.language) {
        case 'es':
            if (command.type === 'merge') {
                const combined = affectedNames.join(' y ');
                return `Perfecto — he combinado ${combined} en una sola nota.`;
            }
            if (command.type === 'delete') {
                return `Listo — he eliminado ${affectedNames[0]} de tus notas.`;
            }
            if (command.type === 'rename') {
                return `Listo — he renombrado ${affectedNames[0]} a *${command.newName}*.`;
            }
            break;
        case 'pt':
            if (command.type === 'merge') {
                const combined = affectedNames.join(' e ');
                return `Perfeito — combinei ${combined} em uma única nota.`;
            }
            if (command.type === 'delete') {
                return `Pronto — removi ${affectedNames[0]} das suas notas.`;
            }
            if (command.type === 'rename') {
                return `Pronto — renomeei ${affectedNames[0]} para *${command.newName}*.`;
            }
            break;
        case 'fr':
            if (command.type === 'merge') {
                const combined = affectedNames.join(' et ');
                return `Parfait — j'ai combiné ${combined} en une seule note.`;
            }
            if (command.type === 'delete') {
                return `C'est fait — j'ai supprimé ${affectedNames[0]} de vos notes.`;
            }
            if (command.type === 'rename') {
                return `C'est fait — j'ai renommé ${affectedNames[0]} en *${command.newName}*.`;
            }
            break;
        case 'en':
        default:
            if (command.type === 'merge') {
                const combined = affectedNames.join(' and ');
                return `Got it — I've combined ${combined} into one note.`;
            }
            if (command.type === 'delete') {
                return `Done — I've removed ${affectedNames[0]} from your notes.`;
            }
            if (command.type === 'rename') {
                return `Done — I've renamed ${affectedNames[0]} to *${command.newName}*.`;
            }
            break;
    }
    return getCommandErrorMessage(command.language);
}
/**
 * Returns a localized error message when a command cannot be executed
 * (e.g., concern not found, invalid input).
 */
function getCommandErrorMessage(language) {
    switch (language) {
        case 'es':
            return `No encontré esa preocupación en tus notas. Puedes ver tus notas actuales en tu página de resumen.`;
        case 'pt':
            return `Não encontrei essa preocupação nas suas notas. Você pode ver suas notas atuais na página de resumo.`;
        case 'fr':
            return `Je n'ai pas trouvé cette préoccupation dans vos notes. Vous pouvez consulter vos notes actuelles sur votre page de résumé.`;
        case 'en':
        default:
            return `I couldn't find that concern in your notes. You can check your current notes on your summary page.`;
    }
}
//# sourceMappingURL=concern-commands.js.map
import TelegramBot from "node-telegram-bot-api";
import TelegramSyncPlugin from "../../main";
import { getChatLink, getForwardFromLink, getReplyMessageId, getTopicLink, getUrl, getUserLink } from "./getters";
import { createFolderIfNotExist } from "src/utils/fsUtils";
import { TFile, normalizePath } from "obsidian";
import { formatDateTime } from "../../utils/dateUtils";
import { displayAndLog, displayAndLogError } from "src/utils/logUtils";
import { createProgressBar, deleteProgressBar, updateProgressBar } from "../progressBar";
import { escapeRegExp, convertMessageTextToMarkdown } from "./convertToMarkdown";
import * as GramJs from "../GramJs/client";
import exp from "constants";

// Delete a message or send a confirmation reply based on settings and message age
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function finalizeMessageProcessing(plugin: TelegramSyncPlugin, msg: TelegramBot.Message, error?: any) {
	if (error) await displayAndLogError(plugin, error, msg);
	if (error || !plugin.bot) {
		return;
	}

	const currentTime = new Date();
	const messageTime = new Date(msg.date * 1000);
	const timeDifference = currentTime.getTime() - messageTime.getTime();
	const hoursDifference = timeDifference / (1000 * 60 * 60);

	if (plugin.settings.deleteMessagesFromTelegram && hoursDifference <= 48) {
		// Send the initial progress bar
		const progressBarMessage = await createProgressBar(plugin.bot, msg, "deleting");

		// Update the progress bar during the delay
		let stage = 0;
		for (let i = 1; i <= 10; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50)); // 50 ms delay between updates
			stage = await updateProgressBar(plugin.bot, msg, progressBarMessage, 10, i, stage);
		}

		await plugin.bot?.deleteMessage(msg.chat.id, msg.message_id);
		await deleteProgressBar(plugin.bot, msg, progressBarMessage);
	} else {
		// Send a confirmation reply if the message is too old to be deleted
		// TODO: needs deep testing and integration
		// if (plugin.botUser) {
		// 	await GramJs.sendReaction(plugin.botUser, msg);
		// }
		await plugin.bot?.sendMessage(msg.chat.id, "...✅...", { reply_to_message_id: msg.message_id });
	}
}

export function getTelegramMdPath(plugin: TelegramSyncPlugin) {
	const location = plugin.settings.newNotesLocation || "";
	const telegramMdPath = normalizePath(location ? `${location}/Telegram.md` : "Telegram.md");
	return telegramMdPath;
}

export async function appendMessageToTelegramMd(
	plugin: TelegramSyncPlugin,
	msg: TelegramBot.Message,
	formattedContent: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	error?: any
) {
	// Do not append messages if not connected
	if (!plugin.botConnected) return;

	// Determine the location for the Telegram.md file
	const location = plugin.settings.newNotesLocation || "";
	createFolderIfNotExist(plugin.app.vault, location);

	const telegramMdPath = getTelegramMdPath(plugin);
	let telegramMdFile = plugin.app.vault.getAbstractFileByPath(telegramMdPath) as TFile;

	// Create or modify the Telegram.md file
	if (!telegramMdFile) {
		telegramMdFile = await plugin.app.vault.create(telegramMdPath, `${formattedContent}\n`);
	} else {
		const fileContent = await plugin.app.vault.read(telegramMdFile);
		await plugin.app.vault.modify(telegramMdFile, `${fileContent}\n***\n\n${formattedContent}\n`);
	}
	await finalizeMessageProcessing(plugin, msg, error);
}

// Apply a template to a message's content
export async function applyNoteContentTemplate(
	plugin: TelegramSyncPlugin,
	templatePath: string,
	msg: TelegramBot.Message,
	fileLink?: string
): Promise<string> {
	let templateContent = "";
	try {
		if (templatePath) {
			const templateFile = plugin.app.vault.getAbstractFileByPath(normalizePath(templatePath)) as TFile;
			templateContent = await plugin.app.vault.read(templateFile);
		}
	} catch (e) {
		throw new Error(`Template "${templatePath}" not found! ${e}`);
	}

	const textContentMd = await convertMessageTextToMarkdown(msg);
	// Check if the message is forwarded and extract the required information
	const forwardFromLink = getForwardFromLink(msg);
	const fullContentMd =
		(forwardFromLink ? `**Forwarded from ${forwardFromLink}**\n\n` : "") +
		(fileLink ? fileLink + "\n\n" : "") +
		textContentMd;

	if (!templateContent) {
		return fullContentMd;
	}

	let voiceTranscript = "";
	if (!templateContent || templateContent.includes("{{voiceTranscript")) {
		voiceTranscript = await GramJs.transcribeAudio(msg, await plugin.getBotUser(msg));
	}

	const messageDateTime = new Date(msg.date * 1000);
	const creationDateTime = msg.forward_date ? new Date(msg.forward_date * 1000) : messageDateTime;

	const dateTimeNow = new Date();
	const itemsForReplacing: [string, string][] = [];

	let proccessedContent = templateContent
		// TODO Copy tab and blockquotes to every new line of {{content*}} or {{voiceTranscript*}} if they are placed in front of this variables.
		.replace("{{content}}", fullContentMd)
		.replace(/{{content:(.*?)}}/g, (_, property: string) => {
			let subContent = "";
			if (property.toLowerCase() == "firstline") {
				subContent = textContentMd.split("\n")[0];
			} else if (property.toLowerCase() == "text") {
				subContent = textContentMd;
			} else if (Number.isInteger(parseFloat(property))) {
				// property is length
				subContent = textContentMd.substring(0, Number(property));
			} else {
				displayAndLog(plugin, `Template variable {{content:${property}}} isn't supported!`, 15 * 1000);
			}
			return subContent;
		}) // message text of specified length
		.replace(/{{file}}/g, fileLink || "")
		.replace(/{{file:link}}/g, fileLink?.startsWith("!") ? fileLink.slice(1) : fileLink || "")
		.replace(/{{voiceTranscript}}/g, voiceTranscript)
		.replace(/{{voiceTranscript:(.*?)}}/g, (_, property: string) => {
			let subContent = "";
			if (property.toLowerCase() == "firstline") {
				subContent = voiceTranscript.split("\n")[0];
			} else if (Number.isInteger(parseFloat(property))) {
				// property is length
				subContent = voiceTranscript.substring(0, Number(property));
			} else {
				displayAndLog(plugin, `Template variable {{voiceTranscript:${property}}} isn't supported!`, 15 * 1000);
			}
			return subContent;
		})
		.replace(/{{messageDate:(.*?)}}/g, (_, format) => formatDateTime(messageDateTime, format))
		.replace(/{{messageTime:(.*?)}}/g, (_, format) => formatDateTime(messageDateTime, format))
		.replace(/{{date:(.*?)}}/g, (_, format) => formatDateTime(dateTimeNow, format))
		.replace(/{{time:(.*?)}}/g, (_, format) => formatDateTime(dateTimeNow, format))
		.replace(/{{forwardFrom}}/g, forwardFromLink)
		.replace(/{{user}}/g, getUserLink(msg)) // link to the user who sent the message
		.replace(/{{userId}}/g, msg.from?.id.toString() || msg.message_id.toString()) // id of the user who sent the message
		.replace(/{{chat}}/g, getChatLink(msg)) // link to the chat with the message
		.replace(/{{chatId}}/g, msg.chat.id.toString()) // id of the chat with the message
		.replace(/{{topic}}/g, await getTopicLink(plugin, msg)) // link to the topic with the message
		.replace(
			/{{topicId}}/g,
			(msg.chat.is_forum && (msg.message_thread_id || msg.reply_to_message?.message_thread_id || 1).toString()) ||
				""
		) // head message id representing the topic
		.replace(/{{messageId}}/g, msg.message_id.toString())
		.replace(/{{replyMessageId}}/g, getReplyMessageId(msg))
		.replace(/{{url1}}/g, getUrl(msg)) // fisrt url from the message
		.replace(/{{url1:preview(.*?)}}/g, (_, height: string) => {
			let linkPreview = "";
			const url1 = getUrl(msg);
			if (url1) {
				if (!height || Number.isInteger(parseFloat(height))) {
					linkPreview = `<iframe width="100%" height="${height || 250}" src="${url1}"></iframe>`;
				} else {
					displayAndLog(plugin, `Template variable {{url1:preview${height}}} isn't supported!`, 15 * 1000);
				}
			}
			return linkPreview;
		}) // preview for first url from the message
		.replace(/{{creationDate:(.*?)}}/g, (_, format) => formatDateTime(creationDateTime, format)) // date, when the message was created
		.replace(/{{creationTime:(.*?)}}/g, (_, format) => formatDateTime(creationDateTime, format)) // time, when the message was created
		.replace(/{{replace:(.*?)=>(.*?)}}/g, (_, replaceThis, replaceWith) => {
			itemsForReplacing.push([replaceThis, replaceWith]);
			return "";
		})
		.replace(/{{replace:(.*?)}}/g, (_, replaceThis) => {
			itemsForReplacing.push([replaceThis, ""]);
			return "";
		});

	itemsForReplacing.forEach(
		// TODO add replacing new lines "\n"
		([replaceThis, replaceWith]) =>
			(proccessedContent = proccessedContent.replace(new RegExp(escapeRegExp(replaceThis), "g"), replaceWith))
	);
	return proccessedContent;
}

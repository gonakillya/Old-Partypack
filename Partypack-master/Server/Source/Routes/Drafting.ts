import j from "joi";
import ffmpeg from "fluent-ffmpeg";
import sizeOf from "image-size";
import cron from "node-cron";
import { Router } from "express";
import { RequireAuthentication, ValidateBody } from "../Modules/Middleware";
import { Song, SongStatus } from "../Schemas/Song";
import { Debug } from "../Modules/Logger";
import { magenta } from "colorette";
import { fromBuffer } from "file-type";
import { rmSync, writeFileSync, renameSync, readFileSync } from "fs";
import { FULL_SERVER_ROOT, MAX_AMOUNT_OF_DRAFTS_AT_ONCE, SAVED_DATA_PATH } from "../Modules/Constants";
import { UserPermissions } from "../Schemas/User";

cron.schedule("*/2 * * * *", async () => {
    Debug("Running cron schedule to check for broken drafts.")
    const EligibleSongs = await Song.find({ where: { IsDraft: true, Status: SongStatus.PROCESSING } });
    for (const SongData of EligibleSongs) {
        if (SongData.HasMidi && SongData.HasCover && SongData.HasAudio)
            continue;

        if (SongData.CreationDate.getTime() + 60 * 1000 > Date.now())
            continue;

        SongData.Status = SongStatus.BROKEN;
        await SongData.save();
    }
});

const App = Router();

App.post("/create",
    RequireAuthentication({ CreatedTracks: true }),
    ValidateBody(j.object({
        Name: j.string().required().min(3).max(64),
        Year: j.number().required().min(1).max(2999),
        ArtistName: j.string().required().min(1).max(64),
        Length: j.number().required().min(1).max(10000),
        Scale: j.string().valid("Minor", "Major").required(),
        Key: j.string().valid("A", "Ab", "B", "Bb", "C", "Cb", "D", "Db", "E", "Eb", "F", "Fb", "G", "Gb").required(),
        Album: j.string().required(),
        GuitarStarterType: j.string().valid("Keytar", "Guitar").required(),
        Tempo: j.number().min(20).max(1250).required(),
        BassDifficulty: j.number().required().min(0).max(6),
        GuitarDifficulty: j.number().required().min(0).max(6),
        DrumsDifficulty: j.number().required().min(0).max(6),
        VocalsDifficulty: j.number().required().min(0).max(6)
    })),
    async (req, res) => {
        if (req.user!.CreatedTracks.length >= Number(MAX_AMOUNT_OF_DRAFTS_AT_ONCE))
            return res.status(400).send("You ran out of free draft spots. Please delete some first.");

        const SongData = await Song.create({
            ...req.body,
            IsDraft: true,
            Status: SongStatus.PROCESSING,
            Author: req.user!
        }).save();

        Debug(`New draft created by ${magenta(req.user!.ID!)} as ${magenta(`${SongData.ArtistName} - ${SongData.Name}`)}`)
        res.json(SongData.Package());
    });

App.post("/upload/midi",
    RequireAuthentication(),
    ValidateBody(j.object({
        Data: j.string().hex().required(),
        TargetSong: j.string().uuid().required()
    })),
    async (req, res) => {
        const Decoded = Buffer.from(req.body.Data, "hex");

        if ((await fromBuffer(Decoded))?.ext !== "mid")
            return res.status(400).send("Uploaded MIDI file is not a valid MIDI.");

        const SongData = await Song.findOne({ where: { ID: req.body.TargetSong }, relations: { Author: true } })
        if (!SongData)
            return res.status(404).send("The song you're trying to upload a MIDI for does not exist.");

        if (req.user!.PermissionLevel! < UserPermissions.Administrator && SongData.Author.ID !== req.user!.ID)
            return res.status(403).send("You don't have permission to upload to this song.");

        if (SongData.HasMidi) {
            if (SongData.Status !== SongStatus.BROKEN && SongData.Status !== SongStatus.DEFAULT && SongData.Status !== SongStatus.DENIED && SongData.Status !== SongStatus.PUBLIC)
                return res.status(400).send("You cannot update this song at this moment.");

            rmSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Data.mid`);
            SongData.HasMidi = false;
            SongData.IsDraft = true;
            await SongData.save();
        }

        writeFileSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Data.mid`, Decoded);
        res.send(`${FULL_SERVER_ROOT}/song/download/${req.body.TargetSong}/midi.mid`);

        await SongData.reload();
        SongData.HasMidi = true;
        SongData.Status = SongData.HasMidi && SongData.HasCover && SongData.HasAudio ? SongStatus.DEFAULT : SongData.Status;
        await SongData.save();
    });

App.post("/upload/cover",
    RequireAuthentication(),
    ValidateBody(j.object({
        Data: j.string().hex().required(),
        TargetSong: j.string().uuid().required()
    })),
    async (req, res) => {
        const Decoded = Buffer.from(req.body.Data, "hex");
        const ext = (await fromBuffer(Decoded))!.ext;

        if (ext !== "png")
            return res.status(404).send("Invalid image file. (supported: png)");

        const SongData = await Song.findOne({ where: { ID: req.body.TargetSong }, relations: { Author: true } })
        if (!SongData)
            return res.status(404).send("The song you're trying to upload a cover for does not exist.");

        if (req.user!.PermissionLevel! < UserPermissions.Administrator && SongData.Author.ID !== req.user!.ID)
            return res.status(403).send("You don't have permission to upload to this song.");

        if (SongData.HasCover) {
            if (SongData.Status !== SongStatus.BROKEN && SongData.Status !== SongStatus.DEFAULT && SongData.Status !== SongStatus.DENIED && SongData.Status !== SongStatus.PUBLIC)
                return res.status(400).send("You cannot update this song at this moment.");

            rmSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Cover.png`);
            SongData.HasCover = false;
            SongData.IsDraft = true;
            await SongData.save();
        }

        try {
            const ImageSize = sizeOf(Decoded);
            if (!ImageSize.height || !ImageSize.width)
                throw new Error("Unknown image size error");

            if (ImageSize.height !== ImageSize.width)
                return res.status(400).send("Image must have a 1:1 ratio.");

            if (ImageSize.width < 512 || ImageSize.width > 2048)
                return res.status(400).send("Image cannot be smaller than 512x512 pixels and larger than 2048x2048 pixels.");
            /*const ImageMetadata = exif(Decoded);
            if (!ImageMetadata.Image?.ImageWidth || !ImageMetadata.Image?.ImageLength)
                throw new Error("Invalid image file.");

            if (ImageMetadata.Image.ImageWidth !== ImageMetadata.Image.ImageLength)
                return res.status(400).send("Image must have a 1:1 ratio.");

            if (ImageMetadata.Image.ImageWidth < 512 || ImageMetadata.Image.ImageWidth > 2048)
                return res.status(400).send("Image cannot be smaller than 512 pixels and larger than 2048 pixels.");*/
        } catch (err) {
            console.error(err)
            return res.status(400).send("Invalid image file.");
        }

        await SongData.reload();
        SongData.HasCover = true;
        SongData.Status = SongData.HasMidi && SongData.HasCover && SongData.HasAudio ? SongStatus.DEFAULT : SongData.Status;
        await SongData.save();

        writeFileSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Cover.png`, Decoded);
        res.send(`${FULL_SERVER_ROOT}/song/download/${req.body.TargetSong}/cover.png`);
    });

App.post("/upload/audio",
    RequireAuthentication(),
    ValidateBody(j.object({
        Data: j.string().hex().required(),
        TargetSong: j.string().uuid().required()
    })),
    async (req, res) => {
        const Decoded = Buffer.from(req.body.Data, "hex");
        const ext = (await fromBuffer(Decoded))!.ext;

        if (!["mp3", "m4a", "ogg", "wav"].includes(ext))
            return res.status(404).send("Invalid audio file. (supported: mp3, m4a, ogg, wav)");

        const SongData = await Song.findOne({ where: { ID: req.body.TargetSong }, relations: { Author: true } })
        if (!SongData)
            return res.status(404).send("The song you're trying to upload audio for does not exist.");

        if (req.user!.PermissionLevel! < UserPermissions.Administrator && SongData.Author.ID !== req.user!.ID)
            return res.status(403).send("You don't have permission to upload to this song.");

        if (SongData.HasAudio) {
            if (SongData.Status !== SongStatus.BROKEN && SongData.Status !== SongStatus.DEFAULT && SongData.Status !== SongStatus.DENIED && SongData.Status !== SongStatus.PUBLIC)
                return res.status(400).send("You cannot update this song at this moment.");

            rmSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Chunks`, { recursive: true });
            SongData.HasAudio = false;
            SongData.IsDraft = true;
            SongData.Status = SongStatus.PROCESSING;
            await SongData.save();
        }

        await writeFileSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Audio.${ext}`, Decoded);
        ffmpeg()
            .input(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Audio.${ext}`)
            .audioCodec("libopus")
            .outputOptions([
                "-use_timeline 1",
                "-f dash",
                "-mapping_family 255"
            ])
            .output(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Chunks/Manifest.mpd`)
            .on("start", cl => Debug(`ffmpeg running with ${magenta(cl)}`))
            .on("end", async () => {
                Debug("Ffmpeg finished running");
                rmSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Audio.${ext}`);

                renameSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Chunks/Manifest.mpd`, `${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Manifest.mpd`);
                // i love creating thread-safe code that always works! (never gonna error trust me)
                writeFileSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Manifest.mpd`, readFileSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Manifest.mpd`).toString().replace(/<ProgramInformation>[\w\d\r\n\t]*<\/ProgramInformation>/i, "<BaseURL>{BASEURL}</BaseURL>"));

                await SongData.reload();
                SongData.HasAudio = true;
                await SongData.save();
            })
            .on("error", async (e, stdout, stderr) => {
                console.error(e);
                console.log(stdout);
                console.error(stderr);
                rmSync(`${SAVED_DATA_PATH}/Songs/${req.body.TargetSong}/Audio.${ext}`);

                await SongData.reload();
                SongData.Status = SongStatus.BROKEN;
                await SongData.save();
            })
            .run();

        res.send("ffmpeg now running on song.");
    });

App.post("/delete",
    RequireAuthentication(),
    ValidateBody(j.object({
        TargetSong: j.string().uuid().required()
    })),
    async (req, res) => {
        const SongData = await Song.findOne({ where: { ID: req.body.TargetSong }, relations: { Author: true } })
        if (!SongData)
            return res.status(404).send("The draft you're trying to delete does not exist.");

        const IsAdmin = req.user!.PermissionLevel! >= UserPermissions.Administrator;
        if (!IsAdmin) {
            if (SongData.Author.ID !== req.user!.ID)
                return res.status(403).send("You don't have permission to remove this draft.");

            if (!SongData.IsDraft)
                return res.status(400).send("This draft has already been published. You need to contact an admin to delete published drafts.");

            if (SongData.Status !== SongStatus.DEFAULT && SongData.Status !== SongStatus.DENIED && SongData.Status !== SongStatus.BROKEN)
                return res.status(400).send("You cannot delete this draft at this moment.");
        }

        await SongData.remove();
        res.send("The draft has been deleted.");
    });

App.post("/submit",
    RequireAuthentication(),
    ValidateBody(j.object({
        TargetSong: j.string().uuid().required()
    })),
    async (req, res) => {
        const SongData = await Song.findOne({ where: { ID: req.body.TargetSong }, relations: { Author: true } })
        if (!SongData)
            return res.status(404).send("The song you're trying to submit for review does not exist.");

        if (SongData.Author.ID !== req.user!.ID)
            return res.status(403).send("You don't have permission to submit this song for approval.");

        if (!SongData.IsDraft)
            return res.status(400).send("This song has already been approved and published.");

        if (SongData.Status === SongStatus.ACCEPTED) {
            SongData.Status = SongStatus.PUBLIC;
            SongData.IsDraft = false;
            await SongData.save();

            return res.send("Song has been published successfully.");
        }

        if (SongData.Status !== SongStatus.DEFAULT)
            return res.status(400).send("You cannot submit this song for review at this time.");

        SongData.Status = req.user!.PermissionLevel! >= UserPermissions.VerifiedUser ? SongStatus.ACCEPTED : SongStatus.AWAITING_REVIEW;
        SongData.DraftReviewSubmittedAt = new Date();
        await SongData.save();

        return res.send("Song has been submitted for approval by admins.");
    });

export default {
    App,
    DefaultAPI: "/api/drafts"
}

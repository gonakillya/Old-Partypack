import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Heading, Box, Button } from "@primer/react";
import axios from "axios";
import { Song } from "../components/Song";

export function AdminSubmissions() {
	const [submissions, setSubmissions] = useState<unknown[]>([]);
	const [bookmarks, setBookmarks] = useState<unknown[]>([]);

    useEffect(() => {
		(async () => {
			const Data = await axios.get("/api/moderation/submissions");
			const Overrides = await axios.get("/api/library/available");

			if (Data.status !== 200 || Overrides.status !== 200)
				return toast("An error has occured while getting the submitted songs!", { type: "error" });

			setSubmissions(Data.data);
		})();
	}, []);

    return (
        <>
			<Heading>Submissions waiting for review</Heading>
			<Box className="songCategory">
			{
				submissions.map(x => {
					return (
						<Song data={x}>
							{
								bookmarks.findIndex(y => y.ID === x.ID) !== -1 ?
									<Button sx={{ width: "100%", marginBottom: 1 }} variant="danger" onClick={async () => {
										const Res = await axios.post("/api/library/me/unbookmark", { SongID: x.ID });
										if (Res.status === 200)
										{
											bookmarks.splice(bookmarks.findIndex(y => y.ID === x.ID), 1);
											setBookmarks([...bookmarks]);
										}
										else
											toast(Res.data, { type: "error" })
									}}>Unsubscribe</Button> :
									<Button sx={{ width: "100%", marginBottom: 1 }} variant="primary" onClick={async () => {
										const Res = await axios.post("/api/library/me/bookmark", { SongID: x.ID });
										if (Res.status === 200)
										{
											bookmarks.push(x);
											setBookmarks([...bookmarks]);
										}
										else
											toast(Res.data, { type: "error" })
									}}>Subscribe</Button>
							}
							<Button sx={{ width: "100%", marginBottom: 1 }} variant="danger" onClick={async () => {
								const Res = await axios.post("/api/moderation/submissions/accept", { SongID: x.ID });
								if (Res.status === 200)
								{
									submissions.splice(submissions.findIndex(y => y.ID === x.ID), 1);
									setSubmissions([...submissions]);
								}
								else
									toast(Res.data, { type: "error" })
							}}>Approve</Button>
							<Button sx={{ width: "100%" }} variant="danger" onClick={async () => { // TODO: reasons
								const Res = await axios.post("/api/moderation/submissions/deny", { SongID: x.ID });
								if (Res.status === 200)
								{
									submissions.splice(submissions.findIndex(y => y.ID === x.ID), 1);
									setSubmissions([...submissions]);
								}
								else
									toast(Res.data, { type: "error" })
							}}>Deny</Button>
						</Song>
					)
				})
			}
			</Box>
        </>
    )
}
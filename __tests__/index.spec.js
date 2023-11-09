import { unstable_dev } from "wrangler";

describe("Newsletter RSS", () => {
  let worker;

  beforeAll(async () => {
    worker = await unstable_dev("index.js", {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it("check a stale news letter and give a consistent response", async () => {
    // picking a stale newsletter https://www.linkedin.com/newsletters/james-caan-s-business-secrets-6676195873757679616/
    const resp = await worker.fetch(
      "/james-caan-s-business-secrets-6676195873757679616"
    );
    const text = await resp.text();
    expect(text).toContain("<title>James Caan&apos;s Business Secrets</title>");
    expect(text).toContain(
      "<link>https://www.linkedin.com/newsletters/james-caan-s-business-secrets-6676195873757679616</link>"
    );
    expect(text).toContain("<description>Answering all your");
    expect(text).toContain("<url>https://media.licdn.com");
    expect(text).toContain(
      "<title>Weekly Roundup: 16th-20th August 2021</title>"
    );
    expect(text).toContain("<description><![CDATA[<p>I d");
    expect(text).toContain("<pubDate>Aug 23, 2021</pubDate>");
    expect(text).toContain("<author>James Caan CBE</author>");
    expect(text).toContain('<enclosure url="https://media.licdn.com');
  });
});

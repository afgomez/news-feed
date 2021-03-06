import { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';

import HeadlinesBody from '../models/HeadLinesBody';
import HttpError from '../../../shared/models/Http-Error';
import NewsModel, { INews } from '../models/db/NewsModel';
import SourceModel, { ISource } from '../models/db/SourceModel';
import SubscriberModel, { ISubscriber } from '../models/db/SubscriberModel';
import SourceBody from '../models/SourceBody';
import SourceUpdatesModel from '../models/db/SourceUpdatesModel';
import PublishedSourceModel from '../models/db/PublishedSourceModel';
import IndexedDataBody from '../models/IndexedDataBody';

export async function cleanData(req: Request, res: Response, next: NextFunction) {
  interface UniqueNews {
    _id: string;
    newsCount: number;
  }
  try {
    const results: Array<UniqueNews> = await NewsModel.aggregate([
      {
        $group: {
          _id: '$title',
          newsCount: { $sum: 1 },
        },
      },
    ]);
    for (const unique of results) {
      if (unique.newsCount > 1) {
        const news = await NewsModel.find({ title: unique._id })
          .sort({ createdAt: 'asc' })
          .limit(unique.newsCount - 1);
        await NewsModel.deleteMany({ _id: { $in: news.map((n) => n._id) } });
      }
    }
    const updatedResults: Array<UniqueNews> = await NewsModel.aggregate([
      {
        $group: {
          _id: '$title',
          newsCount: { $sum: 1 },
        },
      },
    ]);
    return res.json({
      beforeCleaning: {
        results,
        count: results.length,
        totalNews: results.reduce((acc: number, curr: UniqueNews) => acc + curr.newsCount, 0),
      },
      afterCleaning: {
        results: updatedResults,
        count: updatedResults.length,
        totalNews: updatedResults.reduce(
          (acc: number, curr: UniqueNews) => acc + curr.newsCount,
          0,
        ),
      },
    });
  } catch (error) {
    return next(new HttpError(`Error: ${error.message}`, 500));
  }
}

export async function indexData(req: Request, res: Response, next: NextFunction) {
  const body: IndexedDataBody = req.body;
  try {
    await NewsModel.updateMany({ _id: { $in: body.ids } }, { $set: { indexed: true } });
    console.log(body.ids.length + ' documents indexed.');
    return res.json({ message: 'successful' });
  } catch (error) {
    return next(new HttpError(`Error: ${error.message}`, 500));
  }
}

export async function requestData(req: Request, res: Response, next: NextFunction) {
  try {
    const news = await NewsModel.find({ indexed: false }).limit(1000);
    const count = await NewsModel.count({ indexed: false });
    return res.json({ news, count });
  } catch (error) {
    return next(new HttpError(`Error: ${error.message}`, 500));
  }
}

export async function requestSource(req: Request, res: Response, next: NextFunction) {
  try {
    // check if any source exists
    const sources = await SourceModel.find({}).distinct('_id');
    if (!sources || sources.length === 0) {
      return res.status(426).json({ message: 'No sources available.', updateRequest: true });
    }
    // check if any source updates occurred  today
    const updatedToday = await SourceUpdatesModel.findOne({
      createdAt: {
        $gt: new Date().setHours(0, 0, 0, 0),
      },
    });
    if (!updatedToday) {
      // request update source
      return res
        .status(426)
        .json({ message: 'Daily source update is required.', updateRequest: true });
    }

    // send a source
    const updateInProgressSources = await PublishedSourceModel.find({}).distinct('sourceId');
    const source = await SourceModel.find({ _id: { $nin: updateInProgressSources } })
      .sort({
        seqNum: 'asc',
      })
      .limit(1);
    if (!source || source.length !== 1) {
      return res
        .status(404)
        .json({ message: 'Could not find an available source. ', updateRequest: true });
    }

    // save the source to the published sources collection
    await new PublishedSourceModel({ sourceId: source[0]._id }).save();

    // increase the seqNum to get a different source next time
    source[0].seqNum++;
    await source[0].save();

    // send the source
    return res.json({ updateRequest: false, source: source[0] });
  } catch (error) {
    return next(new HttpError(`Error: ${error.message}`, 500));
  }
}

export async function setRenewSources(req: Request, res: Response, next: NextFunction) {
  const sources: Array<SourceBody> = req.body.sources;
  try {
    const existingSources = await SourceModel.find({});
    if (!existingSources || existingSources.length === 0) {
      await SourceModel.insertMany(sources);
      new SourceUpdatesModel({ updated: true, amount: sources.length }).save();
      return res.json({ message: 'updated', updateCount: sources.length });
    }

    const newSources = sources.filter(
      (src) => existingSources.find((eSrc) => eSrc.id === src.id) === undefined,
    );

    if (newSources.length === 0) {
      new SourceUpdatesModel({ updated: false, amount: 0 }).save();
      return res.json({ message: 'no-op', updateCount: 0 });
    }

    await SourceModel.insertMany(
      newSources.map((nSource) => ({ ...nSource, seqNum: existingSources[0].seqNum - 1 })),
    );
    new SourceUpdatesModel({ updated: true, amount: newSources.length }).save();
    return res.json({ message: 'updated', updateCount: newSources.length });
  } catch (error) {
    return next(new HttpError(`Error: ${error.message}`, 500));
  }
}

export async function createAndPublishHeadlines(req: Request, res: Response, next: NextFunction) {
  const headlines: HeadlinesBody = req.body;
  try {
    if (headlines.totalResults === 0) {
      return res.json({ message: 'No news found, so no data added!' });
    }
    if (!headlines.source) {
      return res.json({ message: 'No source found, so no data added!' });
    }
    if (headlines.news.length === 0 || headlines.totalResults !== headlines.news.length) {
      throw new HttpError('Corrupt data provided! No data added!', 400);
    }
    // check for non-existing headlines
    const existingHeadlines = await NewsModel.find({
      title: { $in: headlines.news.filter((hl) => !!hl.title).map((hl) => hl.title) },
      'source.name': headlines.source.name,
    });

    const newsToSave = headlines.news.filter(
      (news) => !existingHeadlines.find((eh) => eh.title === news.title),
    );

    const savedHeadlines: Array<INews> = await NewsModel.insertMany(newsToSave);

    await PublishedSourceModel.deleteOne({ sourceId: headlines.source._id });

    const subscribers: Array<ISubscriber> = await SubscriberModel.find({ active: true });

    const idsAndTitles = savedHeadlines.map((headline: INews) => ({
      id: headline._id,
      title: headline.title,
    }));

    const publishStatus = { success: 0, failure: 0 };
    for (const subscriber of subscribers) {
      // if one subscriber fails, keep publishing, do not crash
      const url =
        subscriber.prod && subscriber.prod === 'production'
          ? subscriber.host
          : `${subscriber.host}:${subscriber.port}`;
      try {
        const subsResp = await fetch(`${url}/${subscriber.endpoint}`, {
          method: subscriber.method,
          body: JSON.stringify(
            subscriber.type && subscriber.type === 'client'
              ? { news: savedHeadlines, type: 'insert' }
              : { news: idsAndTitles },
          ),
          headers: { 'Content-Type': 'application/json' },
        });
        const message = await subsResp.json();
        console.log({ message });
        publishStatus.success++;
      } catch (error) {
        console.error({
          message: error.message,
          subscriber: `${url}/${subscriber.endpoint}`,
          status: 'Failed to publish',
        });
        publishStatus.failure++;
      }
    }

    return res.json({
      db: { status: 'success', total: savedHeadlines.length },
      publish: publishStatus,
    });
  } catch (error) {
    return error instanceof HttpError ? next(error) : next(new HttpError(error.message, 500));
  }
}

export async function updateHeadlinesWithEnhancedData(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  console.log({ message: 'Enhancements received' });
  const headlines: Array<{ [key: string]: any; id: string }> = req.body.headlines;
  try {
    if (!headlines || headlines.length === 0) {
      console.log({ message: 'empty enhancements' });
      return res.json({ message: 'No headlines found, so no data is enhanced!' });
    }

    const news = await NewsModel.find({ _id: { $in: headlines.map((hl) => hl.id) } });

    if (!news || news.length === 0) {
      console.log({ message: 'non-matching enhancements' });
      return res.json({ message: 'Raw and enhanced news do not match, so no data is enhanced!' });
    }

    let enhancements = { success: 0, failure: 0 };
    for (const rawNews of news) {
      try {
        const enhanced = headlines.find((hl) => rawNews._id.toString() === hl.id);
        if (enhanced) {
          Object.keys(enhanced).forEach((key: string) => {
            if (key !== 'id' && key != 'title') {
              rawNews.set(key, enhanced[key]);
            }
          });
          await rawNews.save();
          enhancements.success++;
        }
      } catch (error) {
        console.error(`Enhancement failed for ${rawNews.title}: ${error.message}`);
        enhancements.failure++;
      }
    }

    const subscribers: Array<ISubscriber> = await SubscriberModel.find({
      active: true,
      type: 'client',
    });

    const publishStatus = { success: 0, failure: 0 };
    for (const subscriber of subscribers) {
      // if one subscriber fails, keep publishing, do not crash
      const url =
        subscriber.prod && subscriber.prod === 'production'
          ? subscriber.host
          : `${subscriber.host}:${subscriber.port}`;
      try {
        const subsResp = await fetch(`${url}/${subscriber.endpoint}`, {
          method: subscriber.method,
          body: JSON.stringify({
            news: headlines,
            type: 'update',
            source: news[0].source.language,
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        const message = await subsResp.json();
        console.log({ message });
        publishStatus.success++;
      } catch (error) {
        console.error({
          message: error.message,
          subscriber: `${url}/${subscriber.endpoint}`,
          status: 'Failed to publish',
        });
        publishStatus.failure++;
      }
    }

    return res.json({
      enhancements,
      message: 'enhancements accepted',
      publishStatus,
    });
  } catch (error) {
    return error instanceof HttpError ? next(error) : next(new HttpError(error.message, 500));
  }
}
